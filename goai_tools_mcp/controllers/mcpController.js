'use strict';

const fs = require('fs');
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const toolResult = require('../utils/toolResult');
const heavyGate = require('../utils/heavyGate');

const TOOLS_DIR = path.join(__dirname, 'tools');

// Every controllers/tools/*.js file exports `register(server)`, which calls
// server.registerTool(...) one or more times (a survey that produces two
// related tools — e.g. oklch_convert + oklch_ramp — registers both from one
// file, since they share a data module or helper). Loaded once here rather
// than requiring each tool file to know its own filename convention.
function loadToolModules() {
  if (!fs.existsSync(TOOLS_DIR)) return [];
  return fs
    .readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => require(path.join(TOOLS_DIR, f)));
}
const toolModules = loadToolModules();

// A fresh McpServer per request, not one shared instance connected once at
// boot: this SDK version's Server.connect() binds one transport at a time,
// and each StreamableHTTPServerTransport here lives for exactly one
// request/response cycle (stateless mode — sessionIdGenerator: undefined).
// Registration is pure in-memory bookkeeping (no I/O), so building a new
// server per call costs microseconds and keeps every request fully
// isolated — nothing a handler mutates can leak into the next caller.

// The concurrency gate is applied HERE, by shadowing registerTool for the
// duration of registration, rather than inside each heavy tool file. Two
// reasons. One list of heavy tool names in one place cannot drift from the
// handlers it is supposed to cover, and the five gated tools live in five
// files whose only other thing in common is that they allocate bitmaps. And
// the refusal has to come back as a tool result: this SDK answers over SSE
// (`text/event-stream`, negotiated per request), so a gate wrapped around
// the transport would have to hand-roll that framing, while a gate wrapped
// around the handler lets the SDK produce exactly the envelope every other
// answer uses — which is also what makes server.js's access log record it as
// outcome=error rather than a silent success.
function gateHeavyTools(server) {
  const register = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) => {
    if (!heavyGate.isHeavyTool(name)) return register(name, config, handler);
    return register(name, config, async (...args) => {
      try {
        return await heavyGate.withHeavyGate(() => handler(...args));
      } catch (err) {
        // Only a refused admission becomes a busy message; anything the
        // handler itself threw is the tool's own failure and belongs to the
        // tool's own error path.
        if (err instanceof heavyGate.SemaphoreBusyError) {
          return toolResult.fail(heavyGate.busyMessage(name));
        }
        throw err;
      }
    });
  };
}

function buildServer() {
  const server = new McpServer({ name: 'goai-tools-mcp', version: '1.0.0' });
  gateHeavyTools(server);
  let count = 0;
  for (const mod of toolModules) {
    if (typeof mod.register === 'function') {
      mod.register(server);
      count += typeof mod.toolCount === 'number' ? mod.toolCount : 1;
    }
  }
  return { server, count };
}

// Registered once per request too — same reasoning as buildServer(), and
// resources are even cheaper (one static JSON payload, no drawing/parsing).
function registerResources(server) {
  const iosScreensPath = path.join(__dirname, '..', 'utils', 'data', 'ios-screens.json');
  if (!fs.existsSync(iosScreensPath)) return;
  server.registerResource(
    'ios-screens',
    'resource://goai-tools/ios-screens.json',
    {
      title: 'iOS device screen specs',
      description:
        'Static reference table of iPhone/iPad screen resolutions, points, PPI, and safe-area/cutout type. No computation — this is a lookup table, kept as a resource rather than a tool.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: fs.readFileSync(iosScreensPath, 'utf8'),
        },
      ],
    })
  );
}

function toolCount() {
  return buildServer().count;
}

async function handleMcpRequest(req, res) {
  const { server } = buildServer();
  registerResources(server);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'internal_error' },
        id: (req.body && req.body.id) || null,
      });
    }
  }
}

module.exports = { handleMcpRequest, toolCount, buildServer, loadToolModules, gateHeavyTools };
