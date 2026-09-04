'use strict';

// Logged on response 'finish', not before next() — so a request the security
// stack rejects (401 bad key, 403 CORS, 429 rate limited) is still logged
// with its real status code, matching the sibling services' logger.
//
// Every HTTP request to this service looks identical from the outside
// (POST /mcp), unlike a REST API with one path per capability, and so does
// every response: a tool that failed still answers 200. Both the tool name
// and its verdict therefore come from inside the JSON-RPC body, which
// server.js reads and stashes on the request object (req.mcpToolName /
// req.mcpToolOk — the latter from the result's isError flag) before the
// response finishes. This logger reads whatever is there, defaulting to '-'
// for the health check and any request that never reached a tool call.
function accessLog(req, res, next) {
  res.on('finish', () => {
    const userId = req.headers['x-user-id'];
    const user = typeof userId === 'string' && userId.trim() ? userId.trim() : '-';
    const tool = req.mcpToolName || '-';
    const outcome = req.mcpToolName ? (req.mcpToolOk ? 'ok' : 'error') : '-';
    const line = `${res.statusCode} ${req.method} ${req.path} tool=${tool} outcome=${outcome} ip=${req.ip} user=${user}`;
    console.log(line);
  });
  next();
}

module.exports = { accessLog };
