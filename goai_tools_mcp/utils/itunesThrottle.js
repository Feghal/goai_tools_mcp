'use strict';

// A small counting semaphore bounding how many outbound requests to Apple's
// public iTunes Search/Lookup API (itunes.apple.com/search, /lookup) this
// whole service makes AT ONCE, shared across every tool that calls Apple so
// one busy tool can't starve another's slot budget or (worse) collectively
// blow past what Apple tolerates from a single IP.
//
// This bounds concurrency, not rate: Apple's own limit is roughly 20
// calls/minute/IP (per the source tool's comments), which is a pacing
// problem, not a fan-out problem. A caller that needs to stay under that
// (e.g. sweeping several storefronts) is responsible for its own delay
// between calls -- withThrottle only ever grants "a slot is free right now",
// it does not space out the grants over time.
//
// The FIFO-and-counter mechanism this used to carry inline now lives in
// utils/semaphore.js, shared with utils/heavyGate.js. The policy stays here:
// queue without limit and wait as long as it takes. Waiting for an outbound
// HTTP request costs nothing but time -- unlike the heavy gate, nothing is
// held in memory while a job waits, and no per-call deadline is being eaten.

const { createSemaphore } = require('./semaphore');

const DEFAULT_MAX_CONCURRENT = 4;

function getMaxConcurrent() {
  const raw = Number(process.env.ITUNES_MAX_CONCURRENT);
  // Re-read on every call (rather than caching at module load) so tests --
  // and an operator tweaking the env var on a long-lived process -- can
  // change the cap without a restart. A queued job only picks this up the
  // next time a slot is granted, not retroactively.
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_CONCURRENT;
}

const gate = createSemaphore({ name: 'itunes', max: getMaxConcurrent });

// Runs `fn` (an async function performing one outbound fetch) once a
// concurrency slot is free, and always releases the slot afterwards --
// whether `fn` resolves or rejects. Returns a promise settling the same way
// `fn`'s does.
function withThrottle(fn) {
  return gate.run(fn);
}

module.exports = { withThrottle, getMaxConcurrent };
