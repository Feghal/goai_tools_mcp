'use strict';

const http = require('http');
const app = require('../server');
const outputStore = require('../utils/outputStore');

// These go through a real listener rather than calling the middleware
// directly, because both things under test are properties of the finished
// HTTP response: which headers helmet actually emitted, and what the access
// log printed on 'finish'. A unit test of either would have passed while the
// deployed behaviour was wrong.

let server;
let port;

beforeAll((done) => {
  server = app.listen(0, () => {
    port = server.address().port;
    done();
  });
});

afterAll((done) => {
  outputStore.stopSweeper();
  server.close(done);
});

function request({ method = 'GET', path = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body);
    const req = http.request(
      {
        port,
        path,
        method,
        headers: payload ? { ...headers, 'Content-Length': payload.length } : headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function callTool(name, args, id = 1) {
  return request({
    method: 'POST',
    path: '/mcp',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
}

// The access log is written from a res.on('finish') handler, which can run
// after the client has already seen the last byte. Poll rather than assume.
async function waitForLogLine(lines, match, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = lines.find((l) => l.includes(match));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no access-log line containing ${JSON.stringify(match)}; saw:\n${lines.join('\n')}`);
}

describe('response headers', () => {
  // This service is a PATH on goaichat.app, not a subdomain, so every header
  // it emits lands on the website's origin. HSTS is the one that cannot be
  // taken back: stored per registrable domain, includeSubDomains, one year,
  // and GET /files/:token exists specifically to be opened in a browser.
  const ORIGIN_SCOPED = [
    'strict-transport-security',
    'content-security-policy',
    'x-frame-options',
    'cross-origin-opener-policy',
    'origin-agent-cluster',
  ];

  test('the health check emits nothing that changes the origin\'s policy', async () => {
    const res = await request({ path: '/' });
    expect(res.status).toBe(200);
    for (const h of ORIGIN_SCOPED) expect(res.headers[h]).toBeUndefined();
  });

  test('a real download emits nothing that changes the origin\'s policy', async () => {
    // The route the whole finding turns on: a browser follows this one.
    const token = outputStore.writeOutput(Buffer.from('hello'), 'note.txt', 'text/plain');
    const res = await request({ path: `/files/${token}` });
    expect(res.status).toBe(200);
    expect(res.body).toBe('hello');
    for (const h of ORIGIN_SCOPED) expect(res.headers[h]).toBeUndefined();
  });

  test('the API headers that are per-response, not per-origin, are kept', async () => {
    const res = await request({ path: '/' });
    // nosniff is the one that genuinely matters for a JSON API, and CORP
    // has to stay cross-origin or a browser client cannot read a download.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('access log outcome', () => {
  let lines;
  let spy;

  beforeEach(() => {
    lines = [];
    spy = jest.spyOn(console, 'log').mockImplementation((line) => {
      if (typeof line === 'string') lines.push(line);
    });
  });

  afterEach(() => spy.mockRestore());

  test('a tool call that returns isError logs outcome=error', async () => {
    // handleMcpRequest RESOLVES for this: the tool ran, and said no. The
    // runbook's abuse triage greps this log, so "the promise settled" is the
    // wrong question to answer with it.
    const res = await callTool('check_contrast', { foreground: 'zzz', background: '#ffffff' }, 11);
    expect(res.status).toBe(200);
    expect(res.body).toContain('"isError":true');
    const line = await waitForLogLine(lines, 'tool=check_contrast');
    expect(line).toContain('outcome=error');
  });

  test('a tool call that succeeds still logs outcome=ok', async () => {
    const res = await callTool('check_contrast', { foreground: '#111111', background: '#ffffff' }, 12);
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('"isError":true');
    const line = await waitForLogLine(lines, 'tool=check_contrast');
    expect(line).toContain('outcome=ok');
  });

  test('caller text that looks like the failure marker does not flip the outcome', async () => {
    // The outcome is read by scanning the serialised response rather than
    // parsing it, which is safe only because JSON escapes a quote inside a
    // string value. estimate_ai_tokens echoes contextWindows[].name straight
    // back into its result, so this is a caller putting the marker in the
    // response on purpose, on the success path.
    const res = await callTool(
      'estimate_ai_tokens',
      { text: 'hello', contextWindows: [{ name: '"isError":true', sizeTokens: 1000 }] },
      13
    );
    expect(res.status).toBe(200);
    expect(res.body).toContain('isError'); // it really is in the body...
    expect(res.body).not.toContain('"isError":true'); // ...but only escaped
    const line = await waitForLogLine(lines, 'tool=estimate_ai_tokens');
    expect(line).toContain('outcome=ok');
  });

  test('a request that never reaches a tool logs outcome=-', async () => {
    await request({
      method: 'POST',
      path: '/mcp',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 14, method: 'tools/list' }),
    });
    const line = await waitForLogLine(lines, 'POST /mcp tool=-');
    expect(line).toContain('outcome=-');
  });
});
