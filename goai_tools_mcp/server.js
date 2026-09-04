'use strict';
require('dotenv').config();

const express = require('express');
const { applySecurity } = require('./middleware/security');
const { accessLog } = require('./middleware/accessLog');
const mcpController = require('./controllers/mcpController');
const filesController = require('./controllers/filesController');
const outputStore = require('./utils/outputStore');
const byteLimits = require('./utils/byteLimits');
const fonts = require('./utils/fonts');

const app = express();
const PORT = process.env.PORT || 3000;

// Registered once, at boot, into @napi-rs/canvas's process-global font
// registry — every render_app_store_screenshot call afterward just
// references these families by name, exactly like the sibling controllers
// require utils/toolResult.js once instead of per request.
fonts.registerAll();

app.set('etag', false);

// Access log — registered FIRST so it also sees requests the security stack
// rejects (401 bad key, 403 CORS, 429 rate limited). Logged on 'finish', not
// before, so the real status code is what gets printed. See
// middleware/accessLog.js for how a POST /mcp request's tool name and
// outcome get attached before the response finishes.
app.use(accessLog);

// Rate limit, CORS policy, trusted-proxy hops and whether auth is on at all
// all come from the environment now — see middleware/security.js. Nothing
// about this box's limits should need a code change to retune.
applySecurity(app);

// The JSON body cap tracks utils/byteLimits.js's MAX_INPUT_BYTES (the
// base64-DECODED limit every file-taking tool enforces) plus room for
// base64's ~33% inflation and the surrounding JSON-RPC envelope. Derived
// from that module rather than re-reading the env var, so the two can never
// drift: whatever bound the tools enforce is the bound the parser allows.
const jsonLimitMb = Math.max(1, Math.ceil((byteLimits.MAX_INPUT_BYTES * 1.4) / 1e6));
app.use(express.json({ limit: `${jsonLimitMb}mb` }));

// Health check — public, unauthenticated even when MCP_API_KEY is set,
// curled by Dockerfile.prod's HEALTHCHECK every 30s exactly like every
// sibling.
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'goai-tools-mcp', tools: mcpController.toolCount() });
});

// The MCP endpoint. POST carries every JSON-RPC message.
app.post('/mcp', (req, res) => {
  req.mcpToolName = extractToolName(req.body);
  // Only a tools/call has a verdict worth logging; everything else
  // (initialize, tools/list, notifications) is transport chatter.
  if (req.mcpToolName) watchToolOutcome(req, res);
  mcpController.handleMcpRequest(req, res).catch(() => {
    // Reaches here only if the controller's own catch could not answer at
    // all, i.e. nothing was written for watchToolOutcome to read.
    req.mcpToolOk = false;
  });
});

// A failed tool call and a good one are indistinguishable from out here:
// handleMcpRequest resolves for both, and the HTTP status is 200 either way.
// The tool's own verdict exists only inside the JSON-RPC body, as the
// result's isError flag — so that is what the access log has to read. The
// runbook's abuse triage greps this log for failing calls, and deriving
// "ok" from "the promise resolved" made it blind to exactly those.
//
// Scanned as it streams past rather than buffered and parsed: an inline
// result can be several megabytes of base64 on a 400 MB box, and neither a
// second copy nor a full JSON.parse of it is worth one log field. The marker
// is unambiguous — the SDK serialises with JSON.stringify and no spacing, so
// this exact byte sequence cannot occur inside a string value, where a quote
// would be escaped. The carry-over covers a marker split across two writes.
const IS_ERROR_MARKER = '"isError":true';

function watchToolOutcome(req, res) {
  req.mcpToolOk = true;
  const overlap = IS_ERROR_MARKER.length - 1;
  let carry = '';

  // The transport writes Uint8Array chunks, not strings or Buffers — the
  // first cut of this checked Buffer.isBuffer and silently matched nothing,
  // which is the same failure mode as the bug it was fixing. Viewing the
  // chunk as a Buffer is a cast, not a copy, and buys Buffer#indexOf.
  const searchable = (chunk) => {
    if (typeof chunk === 'string') return chunk;
    if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    return null;
  };

  const scan = (chunk) => {
    if (req.mcpToolOk === false) return;
    const body = searchable(chunk);
    if (body === null) return;
    const head = body.slice(0, overlap).toString();
    if (body.indexOf(IS_ERROR_MARKER) !== -1 || (carry + head).includes(IS_ERROR_MARKER)) {
      req.mcpToolOk = false;
      return;
    }
    // Keep the last overlap-1 characters seen, across however many chunks
    // that took, so a run of tiny writes cannot hide the marker between them.
    const tail = body.slice(Math.max(0, body.length - overlap)).toString();
    carry = (carry + tail).slice(-overlap);
  };

  const write = res.write.bind(res);
  const end = res.end.bind(res);
  res.write = (chunk, ...rest) => {
    scan(chunk);
    return write(chunk, ...rest);
  };
  res.end = (chunk, ...rest) => {
    scan(chunk);
    return end(chunk, ...rest);
  };
}

// GET and DELETE on the MCP endpoint mean "open the server-initiated SSE
// stream" and "terminate this session". This server is stateless
// (sessionIdGenerator: undefined in mcpController.js) — there are no
// sessions to terminate and no server-initiated stream to offer, so the
// Streamable HTTP spec's answer for both is 405 with an Allow header, not
// the generic 404 they used to fall through to. A client that gets 404 here
// cannot tell "wrong URL" from "this transport feature isn't offered".
app.all('/mcp', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'DELETE') return next();
  res.set('Allow', 'POST, OPTIONS');
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'method_not_allowed: this server is stateless; use POST /mcp' },
    id: null,
  });
});

function extractToolName(body) {
  if (body && body.method === 'tools/call' && body.params && typeof body.params.name === 'string') {
    return body.params.name;
  }
  return null;
}

// GET /files/:token — the download link a large/multi-file tool result
// points to. Public even when MCP_API_KEY is set; see the PUBLIC_PATHS note
// in middleware/security.js and utils/outputStore.js.
app.get('/files/:token', filesController.download);

outputStore.startSweeper();

// 404 handler
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found', path: req.originalUrl });
});

// Error handler. Honours err.status: a rejected CORS origin is a policy
// decision (403), not an internal failure, and reporting it as 500 both
// misleads the caller and buries a real 500 in the noise.
app.use((err, _req, res, _next) => {
  const status = Number(err && err.status) || 500;
  if (status >= 500) console.error('Server error:', err);
  const code = status === 500 ? 'internal_error' : (err && err.message) || 'request_rejected';
  res.status(status).json({ ok: false, error: code });
});

if (require.main === module) {
  // Boot-time configuration check. PUBLIC_BASE_URL being wrong or missing is
  // invisible at runtime — the tool call succeeds and the caller gets a link
  // that goes nowhere — so it has to fail here, before anything is serving,
  // rather than one large output later.
  try {
    outputStore.assertConfigured();
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`goai-tools-mcp listening on ${PORT}`);
  });
}

module.exports = app;
