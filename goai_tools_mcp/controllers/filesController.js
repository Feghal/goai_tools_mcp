'use strict';

const fs = require('fs');
const outputStore = require('../utils/outputStore');

// GET /files/:token — public by design, and now actually public: it is
// listed in middleware/security.js's isPublicPath(), so it answers a plain
// GET with no headers even when MCP_API_KEY is set. It has to — a browser
// tab or a generic WebFetch following a resource_link cannot attach a custom
// header. The 128-bit random token, delete-on-download, and the TTL sweep
// are the whole security model for this route.
function download(req, res) {
  const token = req.params.token;
  // One 404 shape for both "not a token" and "no such token": the status and
  // body must not tell a prober whether a token was well-formed.
  const notFound = () => res.status(404).json({ ok: false, error: 'not_found_or_expired' });

  if (!/^[0-9a-f]{32}$/.test(token || '')) return notFound();
  const output = outputStore.readOutput(token);
  if (!output) return notFound();

  res.set('Content-Type', output.mimeType);
  res.set('Content-Length', String(output.bytes));
  res.set('Content-Disposition', `attachment; filename="${output.filename.replace(/"/g, '')}"`);
  // A one-shot link that deletes itself must never be held by an
  // intermediate cache — this service sits behind Cloudflare in production,
  // and a cached copy would outlive both the download and the TTL.
  res.set('Cache-Control', 'no-store');

  const stream = fs.createReadStream(output.filePath);
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).end();
  });
  // Delete AFTER the stream finishes sending, not before: deleting first
  // would race the read that is still in flight.
  res.on('finish', () => outputStore.deleteOutput(token));
  stream.pipe(res);
}

module.exports = { download };
