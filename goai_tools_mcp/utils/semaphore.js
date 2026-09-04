'use strict';

// The one counting-semaphore mechanism in this service. It was
// utils/itunesThrottle.js's private FIFO-plus-active-counter until a second
// caller needed the same thing for a different resource (container memory
// rather than Apple's tolerance for one IP), and two hand-rolled queues that
// drift apart is exactly the failure a shared primitive prevents.
//
// Still no npm dependency: a FIFO of pending jobs plus an active counter,
// both process-local, which is all this single Node process needs.
//
// The two callers want opposite things from a full semaphore, so both are
// options here rather than one policy baked in:
//   - utils/itunesThrottle.js queues without limit. A call that waits its
//     turn for an HTTP request costs nothing but time.
//   - utils/heavyGate.js refuses rather than queues. A queued call there
//     holds a multi-megabyte request body AND spends the caller's own
//     125 s proxy budget before its work even starts; see that file.

// Thrown when a job cannot be admitted: the queue is full, or it waited
// longer than maxWaitMs for a slot. Distinct from anything `fn` itself can
// throw, so a caller can tell "we never ran your work" from "your work
// failed" and answer differently.
class SemaphoreBusyError extends Error {
  constructor(name, waitedMs) {
    super(`${name} is busy`);
    this.name = 'SemaphoreBusyError';
    this.semaphore = name;
    this.waitedMs = waitedMs;
  }
}

// `max`, `maxQueued` and `maxWaitMs` may each be a number or a function
// returning one. Functions are re-read on every admission decision (rather
// than captured at construction) so a test -- or an operator tweaking an env
// var on a long-lived process -- can retune without a restart. A job already
// queued only sees the new value the next time the queue is pumped, not
// retroactively.
function readOption(v, fallback) {
  const raw = typeof v === 'function' ? v() : v;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function createSemaphore(options) {
  const opts = options || {};
  const name = opts.name || 'semaphore';
  const maxOf = () => Math.max(1, Math.floor(readOption(opts.max, 1)));
  const maxQueuedOf = () => Math.floor(readOption(opts.maxQueued, Infinity));
  const maxWaitOf = () => readOption(opts.maxWaitMs, Infinity);

  let active = 0;
  const queue = [];

  // Jobs that timed out are left in place for pump() to skip rather than
  // spliced out, so "how many are still waiting" is not the array's length.
  function liveQueued() {
    return queue.reduce((n, job) => n + (job.settled ? 0 : 1), 0);
  }

  function pump() {
    while (active < maxOf() && queue.length > 0) {
      const job = queue.shift();
      if (job.settled) continue; // timed out while waiting; its slot is free for the next
      if (job.timer) clearTimeout(job.timer);
      job.settled = true;
      active++;
      job.start();
    }
  }

  // Runs `fn` once a slot is free, and always releases the slot afterwards --
  // whether `fn` resolves or rejects. Returns a promise settling the same way
  // `fn`'s does, or rejecting with SemaphoreBusyError if no slot could be had
  // within the configured queue depth and wait.
  function run(fn) {
    return new Promise((resolveOuter, rejectOuter) => {
      const queuedAt = Date.now();
      const maxWaitMs = maxWaitOf();

      // A free slot is always admitted — the queue's depth and the wait only
      // decide what happens to a caller that would have to WAIT. Checking
      // them first would refuse a caller the semaphore could serve
      // immediately, which is the whole thing it exists to allow.
      if (active >= maxOf() && (maxWaitMs <= 0 || liveQueued() >= maxQueuedOf())) {
        rejectOuter(new SemaphoreBusyError(name, 0));
        return;
      }

      const job = {
        settled: false,
        timer: null,
        start() {
          Promise.resolve()
            .then(fn)
            .then(
              (value) => { active--; pump(); resolveOuter(value); },
              (err) => { active--; pump(); rejectOuter(err); }
            );
        },
      };

      if (Number.isFinite(maxWaitMs)) {
        job.timer = setTimeout(() => {
          if (job.settled) return;
          job.settled = true;
          // Left in the queue to be skipped by pump() rather than spliced
          // out: splicing is O(n) and the queue is short-lived either way.
          rejectOuter(new SemaphoreBusyError(name, Date.now() - queuedAt));
        }, maxWaitMs);
        // A pending admission timer must not be what keeps the process
        // alive; the request it belongs to already holds the event loop.
        if (typeof job.timer.unref === 'function') job.timer.unref();
      }

      queue.push(job);
      pump();
    });
  }

  function stats() {
    return { name, active, queued: liveQueued(), max: maxOf() };
  }

  return { run, stats };
}

module.exports = { createSemaphore, SemaphoreBusyError };
