'use strict';

// The behavioural hints every tool advertises in tools/list, kept here for
// the same reason utils/toolResult.js exists: 31 tools should not each get
// to answer "am I safe to retry?" differently, and a hint that drifts from
// the handler is worse than no hint at all — a client trusts it enough to
// skip a confirmation prompt.
//
// Both shapes below are frozen. The SDK copies the object reference straight
// into the tool definition it serialises, so one mutated field would change
// what every tool claims about itself.

// Everything in controllers/tools/ is a pure function of its arguments: it
// decodes the bytes the caller just sent, computes, and returns. Nothing
// reads or writes state the caller could observe on a later call, so the
// same arguments always produce the same answer and a retry after a dropped
// connection is free.
//
// destructiveHint/idempotentHint are only defined for a non-read-only tool
// in the spec, but they are stated rather than omitted: a client that reads
// them without checking readOnlyHint first then gets the cautious-correct
// answer instead of the default (destructive, non-idempotent).
const PURE = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

// appstore_search and appstore_compare_markets, and nothing else here, query
// Apple's iTunes Search API — see the throttle note in
// controllers/tools/appstore.js. Still read-only and still safe to retry,
// but the answer comes from a catalogue that changes without us, so a repeat
// call can legitimately differ.
const NETWORK = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});

module.exports = { PURE, NETWORK };
