'use strict';

// The one place client-supplied base64 gets turned into bytes, so every
// tool that accepts a file rejects an oversized one the same way instead
// of each handler deciding for itself (or forgetting to check at all).
//
// This server is PUBLIC and UNAUTHENTICATED, and runs in a container with a
// hard 400 MB memory limit on a 1 GB box. Every constant below is sized
// against that budget rather than against "what a file might plausibly be".
//
// ---------------------------------------------------------------------------
// MAX_INPUT_BYTES: why 4 MB and not the 30 MB this used to default to
// ---------------------------------------------------------------------------
// Measured on the real linux/amd64 image: at a 30 MB decoded input, the HTTP
// layer alone costs +110 MB before a tool does any work. That is three live
// copies of the same payload, all of which coexist for the whole request:
//
//   1. the raw request body   ~1.4 x D  (base64 inflation + JSON-RPC envelope)
//   2. the parsed JSON string ~1.33 x D (express.json keeps req.body alive;
//      server.js and mcpController.js both read it, so it is not collectable
//      while the tool runs)
//   3. the decoded Buffer      1.0 x D  (what decode() below returns)
//
// i.e. overhead ~= 3.67 x D, which checks out against the measurement
// (3.67 x 30 MB = 110 MB).
//
// The container budget: 400 MB limit, 140 MB idle (31 tools + 22 TTF fonts),
// 350 MB peak design target => ~210 MB for one in-flight call, covering BOTH
// that HTTP overhead and the tool's own working set.
//
// At D = 4 MB the overhead is 3.67 x 4 = ~15 MB, leaving ~195 MB for the tool
// itself. Worked through for the heaviest tool in this set (resize_images /
// generate_app_icon_set / convert_heic_to_jpg_png):
//
//   HTTP overhead ................................ ~15 MB
//   decoded bitmap, at MAX_DECODED_PIXELS ........ ~96 MB
//   sharp/libvips working memory ................. ~50 MB
//   output buffers + the ZIP holding them ........  ~8 MB
//                                                  -------
//   peak ......................................... ~169 MB   (budget 210 MB)
//
// 4 MB is not a squeeze on any legitimate use: a 4 MB JPEG is a 24-megapixel
// camera photo, and a 4 MB PNG is a 2048x2048 32-bit screenshot. Every tool
// that reads bytes here takes a source image, a .mobileprovision (typically
// 8-12 KB), or a .strings file (typically well under 200 KB).
//
// KEEP IN SYNC (both live outside this file, and outside this agent's remit):
//   - server.js:37 derives the Express JSON body limit as
//     ceil(MAX_INPUT_BYTES * 1.4 / 1e6) mb  ->  6mb at this default.
//   - nginx client_max_body_size must sit just ABOVE that (8m) so an
//     oversized body is refused by Express with a clean JSON 413 rather than
//     by nginx with an HTML error page.
const MAX_INPUT_BYTES = Number(process.env.MAX_INPUT_BYTES) || 4 * 1000 * 1000;

// Aggregate cap across every file in ONE call. The batch tools take arrays
// (resize_images up to 200 images, convert_heic_to_jpg_png up to 50 files,
// check_strings_files two or more), and MAX_INPUT_BYTES on its own is a
// PER-FILE bound -- 50 files x 4 MB would be 200 MB of decoded input from a
// single request. In practice the Express body limit already caps the sum,
// but relying on that gives the caller an opaque 413 from the framework;
// enforcing it here names the limit and the tool instead.
const MAX_TOTAL_INPUT_BYTES = Number(process.env.MAX_TOTAL_INPUT_BYTES) || MAX_INPUT_BYTES;

// ---------------------------------------------------------------------------
// Decoded-pixel budget
// ---------------------------------------------------------------------------
// A byte cap on the COMPRESSED input says almost nothing about what it costs
// to decode. Measured: a 16000x16000 solid PNG compresses to 748 KB and
// decodes to 1.02 GB of RGBA. sharp's own default limitInputPixels is
// 268402689 (16383^2), which is ~1.07 GB decoded -- far past this container's
// entire budget, so it has to be lowered explicitly on every sharp() call.
//
// 24 MP => 96 MB of RGBA, which is the "decoded bitmap" line in the budget
// above. It still comfortably admits a 6000x4000 full-frame DSLR frame and
// any phone photo (12 MP), while refusing the decompression bombs.
const MAX_DECODED_PIXELS = Number(process.env.MAX_DECODED_PIXELS) || 24 * 1000 * 1000;

// A separate, tighter bound for the tools that build a max(w,h) x max(w,h)
// SQUARE canvas from the source (generate_app_icon_set's flatten(),
// generate_favicon_set's square()). There, cost is driven by the longest
// side, not by the pixel count: a 1 x 30000 strip is only 30000 pixels --
// it passes any pixel-count check -- but squares to 30000 x 30000 = 3.6 GB.
// Verified: that strip is a 221-BYTE PNG. 221 bytes in, 3.6 GB allocated.
//
// 4096 caps that squared canvas at 4096^2 x 4 = 67 MB, and is still 4x more
// than either tool can use (both resize down to at most 1024).
const MAX_SQUARE_SOURCE_SIDE = Number(process.env.MAX_SQUARE_SOURCE_SIDE) || 4096;

// ---------------------------------------------------------------------------
// Text budget
// ---------------------------------------------------------------------------
// estimate_ai_tokens runs four global .match() passes over its input, each of
// which allocates an ARRAY OF ONE-CHARACTER STRINGS. Measured: 6M characters
// of non-ASCII text costs 219 MB of heap in that one function. 1M characters
// (~250K tokens) covers any prompt a caller could reasonably be sizing --
// including one aimed at a 200K-token context window -- at ~37 MB.
const MAX_TEXT_INPUT_CHARS = Number(process.env.MAX_TEXT_INPUT_CHARS) || 1000000;

// A short bound for the many small free-text fields (colour literals, site
// names, campaign tokens, App Store ids, search terms). None of these has any
// legitimate reason to be long, and several are echoed back into an error
// message or interpolated into an outbound URL, so an unbounded one is an
// amplification vector rather than a feature.
const MAX_SHORT_TEXT_CHARS = 512;

class InputTooLargeError extends Error {
  constructor(actualBytes, limitBytes) {
    super(`input is ${actualBytes} bytes, over the ${limitBytes} byte limit`);
    this.name = 'InputTooLargeError';
    this.actualBytes = actualBytes;
    this.limitBytes = limitBytes;
  }
}

// Raised when a file decodes (or would decode) to more pixels than the
// container can hold, which is a different failure from "the file is big" --
// the file is usually tiny. Kept distinct so a caller can tell the two apart.
class ImageTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageTooLargeError';
  }
}

// Decoded size from the base64 STRING length, before actually allocating
// the buffer — so a deliberately huge string can't force an allocation
// just to find out it should have been rejected.
function estimateDecodedSize(base64) {
  const len = base64.length - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  return Math.floor((len * 3) / 4);
}

// Decodes `base64` to a Buffer, throwing InputTooLargeError first if it
// would exceed `limit` (default MAX_INPUT_BYTES).
function decode(base64, limit) {
  const cap = limit || MAX_INPUT_BYTES;
  const estimated = estimateDecodedSize(base64);
  if (estimated > cap) throw new InputTooLargeError(estimated, cap);
  const buf = Buffer.from(base64, 'base64');
  if (buf.length > cap) throw new InputTooLargeError(buf.length, cap);
  return buf;
}

// Decodes a batch, enforcing the per-file cap on each AND the aggregate cap
// across all of them. `entries` is any array; `pick` returns the base64
// string for one entry. Returns the Buffers in input order.
//
// The aggregate is checked from the base64 lengths BEFORE decoding anything,
// so a 50-file batch that busts the total never allocates even the first
// buffer.
function decodeBatch(entries, pick, opts) {
  const perFile = (opts && opts.perFileLimit) || MAX_INPUT_BYTES;
  const total = (opts && opts.totalLimit) || MAX_TOTAL_INPUT_BYTES;

  let estimatedTotal = 0;
  for (const entry of entries) {
    estimatedTotal += estimateDecodedSize(pick(entry));
  }
  if (estimatedTotal > total) {
    throw new InputTooLargeError(estimatedTotal, total);
  }

  return entries.map((entry) => decode(pick(entry), perFile));
}

// Options object to hand every sharp() constructor in this codebase, so no
// tool silently inherits libvips' own ~1 GB default. Read as a function (not
// a frozen constant) so a test or an operator can move MAX_DECODED_PIXELS
// via env without a restart, matching itunesThrottle's own approach.
function sharpLimits() {
  return { limitInputPixels: MAX_DECODED_PIXELS };
}

// Throws ImageTooLargeError when a decoded (or about-to-be-constructed)
// bitmap busts the pixel budget. Used for the decoders that have no built-in
// limit of their own: @napi-rs/canvas's loadImage() and the libheif WASM
// decoder both hand back a full bitmap for whatever dimensions the container
// declares, with no ceiling.
function assertPixelBudget(width, height, label, maxPixels) {
  const cap = maxPixels || MAX_DECODED_PIXELS;
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!(w > 0) || !(h > 0)) {
    throw new ImageTooLargeError(`${label}: image reports no usable dimensions (${width}x${height}).`);
  }
  if (w * h > cap) {
    throw new ImageTooLargeError(
      `${label}: image is ${w}x${h} (${w * h} pixels), over this server's ${cap}-pixel decode limit. ` +
        'Downscale it before sending -- a large source buys nothing here, since every output is smaller than the limit anyway.'
    );
  }
}

// The squaring tools' extra guard: cost is max(w,h)^2, not w*h.
function assertSquarableSide(width, height, label, maxSide) {
  const cap = maxSide || MAX_SQUARE_SOURCE_SIDE;
  const side = Math.max(Number(width) || 0, Number(height) || 0);
  if (side > cap) {
    throw new ImageTooLargeError(
      `${label}: image is ${width}x${height}. This tool centres the source on a ` +
        `${side}x${side} square canvas, which is over the ${cap}px-per-side limit ` +
        `(${side}x${side} would allocate ${Math.round((side * side * 4) / 1e6)} MB). ` +
        `Send a source no larger than ${cap}px on its longer side.`
    );
  }
}

module.exports = {
  MAX_INPUT_BYTES,
  MAX_TOTAL_INPUT_BYTES,
  MAX_DECODED_PIXELS,
  MAX_SQUARE_SOURCE_SIDE,
  MAX_TEXT_INPUT_CHARS,
  MAX_SHORT_TEXT_CHARS,
  InputTooLargeError,
  ImageTooLargeError,
  estimateDecodedSize,
  decode,
  decodeBatch,
  sharpLimits,
  assertPixelBudget,
  assertSquarableSide,
};
