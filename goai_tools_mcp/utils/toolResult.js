'use strict';

// The one place every tool handler's return value gets shaped into MCP
// content blocks, so 31 tool implementations cannot each invent their own
// answer to "what does a JSON result / an image / a downloadable file /
// an error actually look like on the wire".

// Plain structured data. `structuredContent` lets a client read the result
// as JSON directly; the text block is there for clients (and humans) that
// only render text content.
function ok(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

// A small image returned inline, base64-encoded in the response itself.
// Only for images already confirmed small enough — see
// utils/outputStore.js, which is where that decision is made.
function image(buffer, mimeType) {
  return {
    content: [{ type: 'image', data: buffer.toString('base64'), mimeType }],
  };
}

// A file too large (or a multi-file batch) to inline: a link to fetch it
// from GET /files/:token, plus a text block naming the byte size — the
// content block alone doesn't render a size anywhere a human would see it.
function resourceLink({ uri, name, mimeType, bytes }) {
  return {
    content: [
      { type: 'resource_link', uri, name, mimeType, description: `${bytes} bytes` },
      { type: 'text', text: `${name} (${bytes} bytes) — ${uri}` },
    ],
  };
}

// A tool-level failure (bad input, unsupported format, etc.) — distinct
// from an HTTP/transport error, which Express/the MCP SDK handle on their
// own. isError:true is how a client tells "the tool ran and reported a
// problem" apart from "the tool call itself is malformed".
function fail(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

module.exports = { ok, image, resourceLink, fail };
