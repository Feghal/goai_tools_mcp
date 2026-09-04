'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const toolResult = require('./toolResult');

// The one place a tool's binary output turns into an MCP content block.
// Every tool that produces an image, a ZIP, a GIF, or any other file bytes
// calls emitBinaryOutput() rather than deciding for itself how the bytes
// should cross the wire — so no two tools can disagree about the threshold,
// and adding a 32nd tool tomorrow costs zero new judgment calls.
//
// INLINE: an image, alone, under the threshold — a base64 'image' content
// block, returned directly in the tool-call response.
// EMBEDDED: any other single file under the threshold — a base64 'resource'
// content block. Still inline, just not the MCP 'image' type (which is
// specifically for images clients may want to render).
// LINKED: anything over the threshold, or more than one file (a multi-file
// batch is always a single ZIP handed to this function, so "one file" here
// means one archive, not one-call-one-file) — written to disk and returned
// as a 'resource_link' pointing at GET /files/:token.
//
// Base64 inflates ~33%; fine for a single icon, bad for a 40-file
// screenshot batch or a multi-MB GIF returned inline.

// Where generated files land. The production default has to be the path the
// image actually provisions and the compose file actually mounts a volume
// at — Dockerfile.prod creates /data/outputs node-owned and
// docker-compose.prod.yml mounts tool_outputs there. The old default was
// /app/.data/outputs (this file's own directory, inside the container), so a
// production deploy wrote into the container's ephemeral writable layer
// while the named volume sat empty. Outside a container /data is not
// writable by anyone but root, so dev and the test run keep the repo-local
// path.
const DEFAULT_STORE_DIR = process.env.NODE_ENV === 'production'
  ? '/data/outputs'
  : path.join(__dirname, '..', '.data', 'outputs');
const OUTPUT_STORE_DIR = process.env.OUTPUT_STORE_DIR || DEFAULT_STORE_DIR;

const OUTPUT_TTL_MS = Number(process.env.OUTPUT_TTL_MS) || 60 * 60 * 1000; // 1 hour
const INLINE_OUTPUT_THRESHOLD_BYTES = Number(process.env.INLINE_OUTPUT_THRESHOLD_BYTES) || 4 * 1000 * 1000;

// Hard ceiling on everything in the store at once.
//
// This server is public and unauthenticated, and it shares a 25 GB disk with
// the website it is co-hosted with. A TTL alone bounds how LONG a file
// lives, not how much lives at once: at one call per second a stranger could
// park tens of gigabytes inside the one-hour window and take the website
// down with a full disk. 2 GB is ~8% of the disk, leaves >20 GB free next to
// the ~69 MB site and the container images, and is still hundreds of
// simultaneous live links given that the per-call memory budget on this box
// caps a single output at tens of megabytes.
const OUTPUT_STORE_MAX_BYTES = Number(process.env.OUTPUT_STORE_MAX_BYTES) || 2 * 1000 * 1000 * 1000;

class OutputStoreFullError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OutputStoreFullError';
  }
}

// Created on first write rather than at require time: requiring this module
// must not depend on a path that only exists inside the container (every
// tool module requires it, so a failed mkdir here would take down the whole
// test run and any local `node -e` poke at a tool).
let storeDirReady = false;
function ensureStoreDir() {
  if (storeDirReady) return;
  fs.mkdirSync(OUTPUT_STORE_DIR, { recursive: true });
  storeDirReady = true;
}

// The address callers can actually reach this service at, e.g.
// https://goaichat.app/mcp-tools — a tool handler has no req/res to derive
// it from, so it has to be configuration.
//
// Read per call, never cached. Caching it at module load is how the old
// version silently shipped http://localhost:3000/files/... to a remote agent
// and reported success: a dead link is worse than a failure, because nobody
// finds out until the caller gives up. In production there is no defensible
// fallback, so refuse to mint a link at all; server.js also refuses to boot
// without it, which is where an operator should be hitting this.
function publicBaseUrl() {
  const raw = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (raw) return raw;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'PUBLIC_BASE_URL is not set — refusing to hand out a download link pointing at localhost. ' +
      'Set it to the URL callers reach this service at (e.g. https://goaichat.app/mcp-tools).'
    );
  }
  return `http://localhost:${process.env.PORT || 3000}`;
}

// Called once at boot by server.js: surface a bad store directory or a
// missing PUBLIC_BASE_URL now, loudly, rather than on the first tool call
// that happens to produce a large file.
function assertConfigured() {
  ensureStoreDir();
  publicBaseUrl();
}

function tokenDir(token) {
  // token is always our own crypto.randomBytes hex output — never join a
  // caller-supplied path segment here.
  return path.join(OUTPUT_STORE_DIR, token);
}

// A tool's filename is a LABEL the caller sees on the download — the store
// addresses every file by its random token, and the human name only rides
// along in .meta.json and the Content-Disposition header. It is never a
// path, and must never be joined with a directory as if it were: a caller
// who names a file "../../victim/OWNED.png" would otherwise land bytes
// outside its token directory — invisible to both makeRoom()'s size cap and
// sweep()'s TTL (each of which only walks the token subdirectories), and, on
// the production image where /app is writable by the runtime user, on top of
// the running server itself.
const MAX_FILENAME_LEN = 200; // under the 255-byte ext4/overlayfs component limit, with room for a suffix
function safeFilename(name) {
  // basename() strips every directory part on POSIX, so any path we were
  // handed collapses to its last component; then reduce that to plain
  // filename characters, which drops '/', '\\' and NUL alike so no separator
  // can remain to traverse with.
  let base = path.basename(String(name == null ? '' : name)).replace(/[^A-Za-z0-9._-]/g, '_');
  // A leading dot hides the file and, taken far enough ('.', '..'), is itself
  // a traversal segment — strip every leading dot so the result is an
  // ordinary, visible name.
  base = base.replace(/^\.+/, '');
  if (base.length > MAX_FILENAME_LEN) {
    const ext = path.extname(base).slice(0, 16); // keep the extension recognisable across the truncation
    base = base.slice(0, MAX_FILENAME_LEN - ext.length) + ext;
  }
  // Never empty: a name that was all separators, dots or illegal characters
  // still has to produce a real file the caller can fetch.
  return base || 'output';
}

// Belt and braces: safeFilename() already guarantees a write stays inside its
// token directory, but a store path is never built outside the token dir on
// the say-so of one function. Turns any future slip — or a tampered/legacy
// .meta.json rejoined in readOutput() — into a thrown error instead of a
// traversal.
function assertContained(dir, filePath) {
  const rel = path.relative(dir, filePath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`refusing a path outside its token directory: ${filePath}`);
  }
}

// One stat pass over the store: each token's total bytes on disk and when it
// was created, oldest first. Cheap by construction — everything in here
// expires within OUTPUT_TTL_MS, so the store holds tens of entries, not
// thousands, and this only runs on the LINKED path (a large output that is
// already about to hit the disk).
function listEntries() {
  let tokens;
  try {
    tokens = fs.readdirSync(OUTPUT_STORE_DIR);
  } catch (e) {
    return [];
  }
  const entries = [];
  for (const token of tokens) {
    const dir = tokenDir(token);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      continue; // not a token directory (or vanished under us)
    }
    let bytes = 0;
    for (const name of names) {
      try {
        bytes += fs.statSync(path.join(dir, name)).size;
      } catch (e) {
        /* raced with a sweep or a download-delete; it contributes 0 */
      }
    }
    const meta = readMeta(token);
    entries.push({ token, bytes, createdAt: meta ? meta.createdAt : 0 });
  }
  // Unreadable metadata sorts to createdAt 0, i.e. evicted first — which is
  // right: an entry we can't date is an entry no download can succeed on.
  entries.sort((a, b) => a.createdAt - b.createdAt);
  return entries;
}

function usageBytes() {
  return listEntries().reduce((sum, e) => sum + e.bytes, 0);
}

// Evict oldest-first until `incomingBytes` fits under OUTPUT_STORE_MAX_BYTES.
// Oldest-first because the TTL already says age is what makes an output
// worthless, and the newest link is the one a caller is most likely still
// waiting on.
function makeRoom(incomingBytes) {
  if (incomingBytes > OUTPUT_STORE_MAX_BYTES) {
    // Evicting the entire store still would not fit this one file, so say so
    // instead of deleting everyone else's links for nothing.
    throw new OutputStoreFullError(
      `generated file is ${incomingBytes} bytes, larger than the entire ${OUTPUT_STORE_MAX_BYTES}-byte output store budget ` +
      '(OUTPUT_STORE_MAX_BYTES) — ask for a smaller output, or raise the budget'
    );
  }
  const entries = listEntries();
  let used = entries.reduce((sum, e) => sum + e.bytes, 0);
  for (const entry of entries) {
    if (used + incomingBytes <= OUTPUT_STORE_MAX_BYTES) return;
    deleteOutput(entry.token);
    used -= entry.bytes;
  }
}

function writeOutput(buffer, filename, mimeType) {
  ensureStoreDir();
  makeRoom(buffer.length);
  const token = crypto.randomBytes(16).toString('hex');
  const dir = tokenDir(token);
  fs.mkdirSync(dir, { recursive: true });
  const safe = safeFilename(filename);
  const filePath = path.join(dir, safe);
  assertContained(dir, filePath);
  fs.writeFileSync(filePath, buffer);
  fs.writeFileSync(
    path.join(dir, '.meta.json'),
    // Persist the SANITISED name: it is what the file was actually written as,
    // and what readOutput()/the download must hand back.
    JSON.stringify({ filename: safe, mimeType, createdAt: Date.now() })
  );
  return token;
}

function readMeta(token) {
  const dir = tokenDir(token);
  const metaPath = path.join(dir, '.meta.json');
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function readOutput(token) {
  const meta = readMeta(token);
  if (!meta) return null;
  const dir = tokenDir(token);
  const filePath = path.join(dir, meta.filename);
  // meta.filename is sanitised at write time, but this route must not trust
  // that: a tampered or older-build .meta.json could rejoin a traversing name
  // and we would happily stream whatever it pointed at. Same containment rule
  // as writeOutput().
  try {
    assertContained(dir, filePath);
  } catch (e) {
    return null;
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    return null; // meta without payload — a half-written or half-swept entry
  }
  // bytes so the download can send a real Content-Length instead of chunking
  // a file whose size we already know.
  return { filePath, filename: meta.filename, mimeType: meta.mimeType, bytes: stat.size };
}

function deleteOutput(token) {
  fs.rmSync(tokenDir(token), { recursive: true, force: true });
}

// Deletes any output past its TTL. Deletion also happens once-per-download
// in filesController — this sweep is the backstop for a link nobody ever
// fetches. The size cap in makeRoom() is the other backstop, for the case
// where the store fills faster than the TTL empties it.
function sweep() {
  let entries;
  try {
    entries = fs.readdirSync(OUTPUT_STORE_DIR);
  } catch (e) {
    return;
  }
  const now = Date.now();
  for (const token of entries) {
    const meta = readMeta(token);
    if (!meta || now - meta.createdAt > OUTPUT_TTL_MS) {
      deleteOutput(token);
    }
  }
}

let sweeper = null;
function startSweeper(intervalMs) {
  if (sweeper) return sweeper;
  sweeper = setInterval(sweep, intervalMs || 5 * 60 * 1000);
  sweeper.unref(); // never keep the process alive for this alone
  return sweeper;
}
function stopSweeper() {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}

// buffers: Buffer | { buffer: Buffer, filename: string, mimeType: string }
function emitBinaryOutput({ buffer, mimeType, filename }) {
  const isImage = /^image\//.test(mimeType);
  if (isImage && buffer.length <= INLINE_OUTPUT_THRESHOLD_BYTES) {
    return toolResult.image(buffer, mimeType);
  }
  if (!isImage && buffer.length <= INLINE_OUTPUT_THRESHOLD_BYTES) {
    return {
      content: [
        {
          type: 'resource',
          resource: {
            // Not a fetchable URL — a synthetic identifier for a resource
            // embedded directly in this response, per the MCP embedded-
            // resource content type. Only used for small non-image files;
            // anything a client would want a real link for goes through
            // the token-store branch below instead.
            uri: `embedded:///${encodeURIComponent(filename)}`,
            mimeType,
            blob: buffer.toString('base64'),
          },
        },
      ],
    };
  }

  // A full store or an unwritable store directory is an operator problem,
  // but the caller is the one waiting for an answer — report it as a tool
  // failure with the real reason rather than letting it surface as a bare
  // transport 500 the caller cannot act on.
  let token;
  try {
    token = writeOutput(buffer, filename, mimeType);
  } catch (err) {
    console.error('outputStore: could not persist tool output:', err);
    return toolResult.fail(`could not store the generated file: ${err.message}`);
  }

  let base;
  try {
    base = publicBaseUrl();
  } catch (err) {
    // Never leave the bytes on disk for a link we refuse to hand out.
    deleteOutput(token);
    console.error('outputStore: could not build a download link:', err);
    return toolResult.fail(err.message);
  }

  const uri = `${base}/files/${token}`;
  return toolResult.resourceLink({ uri, name: filename, mimeType, bytes: buffer.length });
}

module.exports = {
  OUTPUT_STORE_DIR,
  OUTPUT_TTL_MS,
  INLINE_OUTPUT_THRESHOLD_BYTES,
  OUTPUT_STORE_MAX_BYTES,
  OutputStoreFullError,
  publicBaseUrl,
  assertConfigured,
  safeFilename,
  usageBytes,
  makeRoom,
  writeOutput,
  readOutput,
  deleteOutput,
  sweep,
  startSweeper,
  stopSweeper,
  emitBinaryOutput,
};
