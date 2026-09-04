'use strict';

// .env.dev is the file `docker compose up` feeds the dev container, and a
// value in it that contradicts production is worse than no value at all: the
// whole point of running the stack locally is that what happens here is what
// happens there. Two settings had drifted far enough to make production
// behaviour unreproducible, so they get a test rather than a comment.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ENV_DEV = path.join(REPO_ROOT, '.env.dev');
const COMPOSE = path.join(REPO_ROOT, 'docker-compose.yml');

const byteLimits = require('../utils/byteLimits');

// .env parsing, only as much of it as this file needs: KEY=VALUE lines,
// ignoring blanks and #-comments. Commented-out settings deliberately do not
// count as set — that is how both files say "use the code's default".
function readEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

describe('.env.dev reproduces production', () => {
  const env = readEnvFile(ENV_DEV);

  test('MAX_INPUT_BYTES is not pinned, so dev runs the same 4 MB bound as production', () => {
    // It used to be 30000000 — the pre-rework default, which this 400 MB
    // container cannot hold. server.js derives express.json's body limit from
    // MAX_INPUT_BYTES, so pinning it here gave dev a 42 MB parser in front of
    // tools bounded for 4 MB: every production rejection path was unreachable
    // locally, which is exactly where you would want to exercise it.
    expect(env.MAX_INPUT_BYTES).toBeUndefined();
    expect(byteLimits.MAX_INPUT_BYTES).toBe(4 * 1000 * 1000);
    // The derived Express limit, spelled out here because it is what a body
    // over the bound actually meets first.
    expect(Math.max(1, Math.ceil((byteLimits.MAX_INPUT_BYTES * 1.4) / 1e6))).toBe(6);
  });

  test('OUTPUT_STORE_DIR is the path docker-compose.yml actually mounts', () => {
    // ./.data/outputs resolved to /app/.data/outputs inside the container,
    // so generated files landed in the ephemeral writable layer while the
    // bind mount sat empty — the same bug already fixed once in production
    // (see utils/outputStore.js's DEFAULT_STORE_DIR note).
    const compose = fs.readFileSync(COMPOSE, 'utf8');
    const mount = /:\s*(\/[^\s'"]*outputs)\s*$/m.exec(compose);
    expect(mount).not.toBeNull();
    expect(env.OUTPUT_STORE_DIR).toBe(mount[1]);
    expect(path.isAbsolute(env.OUTPUT_STORE_DIR)).toBe(true);
  });

  test('the heavy-tool gate is left at its production defaults', () => {
    // Unset means one heavy call at a time, refused rather than queued. A dev
    // box that quietly ran them concurrently would hide the OOM the gate
    // exists to prevent.
    expect(env.MCP_HEAVY_MAX_CONCURRENT).toBeUndefined();
    expect(env.MCP_HEAVY_QUEUE_WAIT_MS).toBeUndefined();
  });
});
