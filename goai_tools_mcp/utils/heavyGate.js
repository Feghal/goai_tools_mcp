'use strict';

// One-at-a-time admission for the tools that can allocate a large fraction
// of the container on their own.
//
// WHY THIS EXISTS. Every per-tool memory bound in this service was sized
// against the 400 MB container cap assuming ONE CALL AT A TIME, and until
// this file nothing enforced that assumption. Measured on the real image at
// `--memory 400m --cpus 0.75`, with inputs each entirely inside the byte,
// pixel and page bounds their tool advertises:
//
//   2 x image_compress                 -> exit 137, OOMKilled
//   2 x render_app_store_screenshot    -> exit 137, OOMKilled
//   8 x convert_video_to_gif           -> OOM kill inside the container
//
// On a public, unauthenticated endpoint with `restart: unless-stopped` that
// is not one failed call, it is a restart loop: the kill takes every
// in-flight request with it, and whatever sent two calls sends two more.
//
// WHY A SEMAPHORE OF 1 AND NOT 2. Same measurements. Two concurrent calls of
// the two worst tools is already fatal, so 2 does not survive its own worst
// case. The per-call anon-memory peaks that produce that, against a ~40 MB
// idle container:
//
//   render_app_store_screenshot  219 MB   (10 pages, 13" iPad, worst sources)
//   image_compress               147 MB   (24 MP source, webp q100)
//   convert_video_to_gif         143 MB   (12 MP of animation)
//   resize_images                112 MB   (48 MB of PNG output)
//   image_compression_curve       76 MB   <- below the bar, NOT gated
//
// WHY REJECT RATHER THAN QUEUE. Cloudflare hangs up at 125 s and that
// ceiling is not raisable outside Enterprise. A queued call spends the
// caller's own budget before its work starts: the worst measured heavy call
// runs 29 s here and convert_video_to_gif self-limits at 90 s, so a wait
// long enough to be worth having is long enough to push the run that
// follows it past the hang-up -- and the caller then pays the full render
// cost for a response nobody receives. Refusing in milliseconds with a
// message that says to retry is strictly better than a 524. It also keeps
// the refused request from holding its parsed multi-megabyte body for the
// length of the wait, which is memory the running call needs.
//
// MCP_HEAVY_QUEUE_WAIT_MS exists for an operator who disagrees on a quieter
// box: set it above 0 and a call will wait that long for a slot before being
// refused, bounded by MCP_HEAVY_QUEUE_DEPTH so a burst cannot pile up bodies.
// Keep wait + the tool's own worst run under 125 s or the wait buys nothing.

const { createSemaphore, SemaphoreBusyError } = require('./semaphore');

// Which tools count as heavy: the ones that decode input to a
// full-resolution bitmap (or a whole animation's worth of them) and hold it.
// Measured above, except convert_heic_to_jpg_png -- this build's sharp has
// no HEIC encoder so no HEIC fixture could be made here, and a JPEG input is
// passed through undecoded. It is gated on its decode path instead: libheif
// hands back raw RGBA at up to byteLimits.MAX_DECODED_PIXELS, which is 96 MB
// for one file, the same band as resize_images.
const HEAVY_TOOLS = new Set([
  'render_app_store_screenshot',
  'convert_video_to_gif',
  'image_compress',
  'resize_images',
  'convert_heic_to_jpg_png',
]);

function isHeavyTool(name) {
  return typeof name === 'string' && HEAVY_TOOLS.has(name);
}

// Read per admission decision, not at module load, for the same reason
// itunesThrottle re-reads its own cap: retuning a live box should not need a
// redeploy.
function envNumber(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

const gate = createSemaphore({
  name: 'heavy-tools',
  max: () => Math.max(1, Math.floor(envNumber('MCP_HEAVY_MAX_CONCURRENT', 1))),
  maxQueued: () => Math.floor(envNumber('MCP_HEAVY_QUEUE_DEPTH', 4)),
  maxWaitMs: () => envNumber('MCP_HEAVY_QUEUE_WAIT_MS', 0),
});

// Phrased for the agent that has to decide what to do next: what happened,
// that it is transient, and that the fix is to retry rather than to shrink
// the request (which is what every other refusal from these tools means).
function busyMessage(toolName) {
  return (
    `${toolName} is temporarily unavailable: this server runs the memory-heavy tools one at a time ` +
    '(they each need a large share of a 400 MB container, and running two at once kills it), and ' +
    'another such call is in flight right now. Nothing is wrong with this request -- retry it in ' +
    'about 30 seconds. If it matters that it succeeds first time, send heavy calls one after another ' +
    'rather than in parallel.'
  );
}

// Runs `fn` if a slot is free. Rejects with a SemaphoreBusyError -- never
// runs `fn` -- when one is not; callers turn that into a tool-level error,
// which is what an MCP client can actually read and act on.
function withHeavyGate(fn) {
  return gate.run(fn);
}

module.exports = {
  withHeavyGate,
  isHeavyTool,
  busyMessage,
  SemaphoreBusyError,
  HEAVY_TOOLS,
  stats: gate.stats,
};
