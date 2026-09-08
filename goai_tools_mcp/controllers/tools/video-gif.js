'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { z } = require('zod');
const toolResult = require('../../utils/toolResult');
const toolAnnotations = require('../../utils/toolAnnotations');
const byteLimits = require('../../utils/byteLimits');
const outputStore = require('../../utils/outputStore');
const gifEncoder = require('../../utils/gifEncoder');

const fsp = fs.promises;

// Ported from nginx/sites/goai/tools/live-photo.html's inline <script>, which
// samples the video half of an iPhone Live Photo (or any short clip) with a
// manual mip-map <canvas> chain plus requestVideoFrameCallback/seek, builds a
// shared median-cut palette across every sampled frame (utils/gifEncoder.js,
// itself a verbatim port of assets/gif.js), and writes a GIF89a byte stream.
// None of the in-browser frame-grabbing machinery (prepare/capture/
// grabByPlaying/grabBySeeking) ports server-side -- it exists solely to
// manage in-browser decode cost. Here, ffmpeg reads and decodes the video
// directly, in one invocation, piping raw RGBA frames out at the requested
// sampling rate; see extractFrames() for exactly how that approximates the
// source's evenly-spaced-sample-times semantics.

// ---------------------------------------------------------------------------
// Resource envelope
// ---------------------------------------------------------------------------
// The browser source is bounded only by what the user's own phone is willing
// to decode: it spends the caller's RAM and the caller's battery, and a job
// that is too big simply gets slow on one person's device. This is a shared,
// public, unauthenticated host running in a 400 MB container on one shared
// vCPU behind a proxy that returns 524 at 125 s and cannot be given a longer
// timeout. So every input that scales cost is bounded here, and an over-budget
// request is REJECTED with a message naming the limit rather than being
// accepted and then OOM-killed or cut off mid-flight by the edge.
//
// Peak RSS for the GIF path is:
//
//     peak = idle
//          + inputOverhead(~3.7 x decoded input bytes: raw body + JSON string
//            + decoded Buffer, all live at once)
//          + max( 4 x W x H x sampledFrames,      // RGBA frames, at their peak
//                 3 x gifBytes )                  // writer growth + final slice
//
// Measured on the linux/amd64 image under `--memory 400m --cpuset-cpus 0`,
// against a resting footprint of 198 MB (all 31 tools loaded, 22 TTF fonts
// registered, and one McpServer built -- which is the state a request actually
// runs in, not the 140 MB the process settles at between requests):
//
//   at the ceiling, 480x854 x 29 frames = 11.9 Mpx ......... 284 MB, 25.6 s
//   the same, from a pure-noise source (worst-case LZW) .... 297 MB, 21.0 s
//   240x428 x 116 frames = 11.9 Mpx, pure noise ........... 300 MB, 22.3 s
//   at the new defaults, 320x568 x 30 frames ............... 247 MB, 15.8 s
//
// The same 480x854 x 29 request cost 382 MB (396 MB on noise) before this
// rewrite, and the tool's OWN former schema defaults were OOM-killed outright.
//
// The 4x term used to be a 12x term: three simultaneous full copies of the
// RGBA stream (stdout chunk accumulation, then Buffer.concat over the lot,
// then a copying per-frame Uint8ClampedArray sliced back out of it). Frames are
// now assembled straight out of ffmpeg's stdout into their final per-frame
// buffer, and each one is dropped the instant its palette-index frame exists.
// See extractFrames() and buildGif().
//
// The other half of that rewrite is not visible in the memory model at all,
// because it was never a memory problem: bounce mirrors frames BY REFERENCE, so
// it always cost the same RAM as loop -- and twice the time, since every
// mirrored frame was dithered and quantised a second time. Measured on the
// original at 480x854 x 45 frames: loop 55.5 s, bounce 97.5 s, for 481 MB and
// 483 MB respectively. buildGif's index cache is what closes that gap.
//
// MAX_OUTPUT_PIXELS is the single governing bound, because width, height,
// frame count, fps, speed and trim span all fold into it, and it is what
// actually drives both memory and the JS-side wall clock (histogram +
// Floyd-Steinberg + LZW are all linear in emitted pixels).
const SIZES = [0, 720, 480, 320, 240];        // 0 = keep source width (clamped to MAX_WIDTH)
const FPS = [10, 12, 15, 20, 25];
const COLOURS = [256, 128, 64];
const SPEEDS = [0.5, 1, 1.5, 2];
const MOTION = ['loop', 'bounce', 'once'];

// Emitted pixels = width x height x (frames actually written to the file, i.e.
// after bounce mirroring). 12 M px puts the RGBA working set at no more than
// 4 x 12 M = 48 MB, and the worst GIF measured out of it -- a pure-noise source,
// dithered, which is as badly as LZW can possibly do -- at 13.6 MB (1.14
// bytes/px), whose 3x writer transient is ~41 MB. Both sit inside the ~150 MB
// this tool has between a 198 MB resting footprint and the 350 MB design
// target, and the measurements above confirm it: nothing legal exceeded 300 MB.
//
// It is also what keeps the wall clock honest. The histogram, the
// Floyd-Steinberg pass and LZW are all linear in emitted pixels, so bounding
// them bounds the one number the 125 s edge timeout cares about.
const MAX_OUTPUT_PIXELS = 12 * 1000 * 1000;

// Secondary caps. None of these is the binding constraint on a normal clip --
// MAX_OUTPUT_PIXELS is -- but each closes a hole that pixel-counting alone
// does not: MAX_WIDTH stops `size: 0` from inheriting a 4K source's own width,
// MAX_FRAMES bounds per-frame GIF header overhead and LZW dictionary resets
// for very small frames, and MAX_SPAN_SECONDS bounds how much source video
// ffmpeg has to DECODE (a 60 s trim sampled down to 20 frames is cheap in
// pixels and ruinous in decode time).
const MAX_WIDTH = 720;
const MAX_FRAMES = 120;
const MAX_SPAN_SECONDS = 10;

// Pinned to the server-wide per-file cap rather than restated as a second,
// divergent number. Two reasons it must not be raised locally: the HTTP layer
// holds roughly 3.7 bytes for every decoded byte (raw body Buffer, parsed JSON
// string and decoded Buffer all live at once), and express.json's body limit
// in server.js is DERIVED from MAX_INPUT_BYTES -- so a video above it is
// refused with a 413 before this handler is ever reached, and a local cap
// above it would only ever produce a confusing error from the wrong layer.
// Named here so the schema and the description can state the real figure.
const MAX_INPUT_VIDEO_BYTES = byteLimits.MAX_INPUT_BYTES;

// Every optional argument's default, in one place, applied by
// convertVideoToGif() itself AND quoted by the schema below so the two cannot
// disagree. It has to be the function's own job, not only the schema's: with
// `colours` left undefined, gifEncoder.palette()'s `while (boxes.length <
// maxColors)` is false on its first test, so the call SUCCEEDS and returns a
// 2-colour GIF. A degenerate result reported as a success is the one failure
// mode worth spending a few lines to make unreachable.
const INPUT_DEFAULTS = {
  startSeconds: 0,
  size: 320,
  fps: 10,
  motion: 'loop',
  speed: 1,
  colours: 256,
  dither: true,
  format: 'gif',
};

// Backstop, not a scheduler. Every bound above is chosen so a legal request
// finishes in a fraction of this; it exists so that a pathological input which
// somehow slips past them (a container that makes ffmpeg spin, a decoder
// stall) returns a clean, explained tool error instead of being cut off by
// Cloudflare's un-raisable 125 s proxy timeout as an opaque 524.
const HARD_DEADLINE_MS = 90 * 1000;

// ffmpeg's diagnostics are the only thing we keep from stderr, and a corrupt
// file can produce megabytes of them. Only the tail is ever reported.
const STDERR_KEEP_BYTES = 16 * 1024;

// ffmpeg sizes its decoder and filter thread pools from the CPU COUNT IT CAN
// SEE, and each thread carries its own frame buffers. That is invisible on the
// deployment box (one vCPU, so it picks one thread anyway) and ruinous
// anywhere the container can see more cores than its cpu quota lets it use --
// which is every Docker host that sets --cpus rather than --cpuset-cpus.
// Measured decoding one 3840x2160 clip in a 10-core container:
//
//   default threading ................................. 398 MB, 35.9 s
//   -threads 1 ........................................ 152 MB, 26.8 s
//   -threads 1 -filter_threads 1 ...................... 145 MB, 21.3 s
//
// 398 MB is the whole container budget spent by the CHILD process alone, which
// is exactly how a 4K source used to fail here with a decode error rather than
// a bounded one. Pinning the pools costs nothing on one core (there is no
// parallelism to give up) and is 2.7x cheaper and, because the threads were
// only contending, faster. Threading in libavcodec is bit-exact either way, so
// the decoded frames are unchanged.
const THREAD_ARGS = ['-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1'];

function extFromMime(mimeType) {
  const m = String(mimeType || '').toLowerCase();
  if (m.includes('quicktime') || m.includes('mov')) return 'mov';
  if (m.includes('webm')) return 'webm';
  if (m.includes('matroska')) return 'mkv';
  if (m.includes('3gpp')) return '3gp';
  if (m.includes('mp4')) return 'mp4';
  return 'bin'; // ffmpeg demuxes by content, not extension, so this is only cosmetic
}

function appendStderr(buf, chunk) {
  if (buf.length >= STDERR_KEEP_BYTES) return buf;
  return (buf + chunk.toString('utf8')).slice(-STDERR_KEEP_BYTES);
}

// Runs ffmpeg to completion, always resolving (never rejecting on a non-zero
// exit code) so a corrupt/unsupported input surfaces as ordinary stderr text
// a caller can turn into a clean toolResult.fail rather than an uncaught
// child_process exception. Only a genuinely broken ffmpeg binary/spawn
// failure rejects -- that is an infra fault, not a user-input problem.
//
// stdout is drained and DISCARDED here. The only callers are probeVideo (which
// asks for no output at all) and buildVideo (which writes to a file), so
// buffering it bought nothing and cost a full second copy of whatever came
// down the pipe. The raw-frame path does its own streaming read in
// extractFrames() instead.
function runFfmpeg(args, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 0;
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs) : null;
    if (timer) timer.unref();

    child.stdout.resume(); // must be drained or ffmpeg blocks on a full pipe
    child.stdout.on('error', () => {});
    child.stderr.on('data', (d) => { stderr = appendStderr(stderr, d); });
    child.stderr.on('error', () => {});
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stderr, code, timedOut });
    });
  });
}

// ffmpeg-static ships ffmpeg only, not ffprobe, so duration and resolution
// are read from `ffmpeg -i <file>` itself: with no output specified it always
// exits non-zero, but stderr carries the stream info we need either way.
async function probeVideo(filePath, timeoutMs) {
  const { stderr } = await runFfmpeg([...THREAD_ARGS, '-i', filePath], { timeoutMs });
  const resMatch = stderr.match(/Video:[^\n]*?(\d{2,5})x(\d{2,5})/);
  if (!resMatch) {
    throw new Error(
      `That file could not be read as a video (no decodable video stream found). ffmpeg said: ${stderr.trim().slice(-400) || 'no output'}`
    );
  }
  const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = durMatch ? (+durMatch[1] * 3600 + +durMatch[2] * 60 + parseFloat(durMatch[3])) : null;
  return { width: parseInt(resMatch[1], 10), height: parseInt(resMatch[2], 10), duration };
}

// One ffmpeg invocation, not one process per frame: trims to [start, end]
// with fast input-side seeking (-ss/-to before -i, exactly as the task
// spec's suggested command), scales, samples at `count / span` frames per
// second, and pipes raw RGBA straight out over stdout.
//
// The frames are assembled AS THEY ARRIVE, straight into their own final
// width*height*4 buffer, and ffmpeg is killed the moment the last one is
// complete. That matters more than it looks: the previous version pushed every
// stdout chunk onto an array, Buffer.concat'd the lot into one contiguous
// buffer, and then copied each frame out of that buffer into a fresh
// Uint8ClampedArray -- three full-size copies of the same RGBA stream alive at
// once, for a measured 3x multiplier on the single largest allocation this
// tool makes. Streaming keeps exactly one copy (the frames themselves) plus
// whatever 64 KB chunk the pipe just handed us.
//
// This is a deliberate, documented approximation of the source's semantics,
// not a literal port: the source samples `count` *exact* timestamps
// (start + span*i/count for i in [0, count)) by seeking or by watching
// requestVideoFrameCallback; ffmpeg's fps filter instead resamples the
// decoded stream to a target rate, which can land on very slightly different
// instants and, because of how it rounds a fractional target duration, may
// produce one frame more or fewer than `count`. Rather than let that
// discrepancy leak into the result, the output is normalized to exactly
// `count` frames: extras are never even read off the pipe, and if ffmpeg
// produced fewer, the last real frame is repeated to pad out the rest (by
// reference -- a repeated frame costs one array slot, not another bitmap).
function extractFrames({ inputPath, start, end, span, count, width, height, timeoutMs }) {
  const samplingFps = count / span;
  const frameBytes = width * height * 4;
  const args = [
    '-y',
    ...THREAD_ARGS,
    '-ss', String(start),
    '-to', String(end),
    '-i', inputPath,
    '-vf', `fps=${samplingFps},scale=${width}:${height}:flags=lanczos`,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    'pipe:1',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const frames = [];
    let current = null;   // the partially-filled frame, if a chunk straddled a boundary
    let filled = 0;
    let stderr = '';
    let stopped = false;
    let settled = false;
    let timedOut = false;

    const timer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; stopped = true; try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, timeoutMs)
      : null;
    if (timer) timer.unref();

    // Everything still in the pipe past frame `count` would be truncated
    // anyway; killing here also stops ffmpeg decoding source frames whose
    // pixels we would immediately throw away.
    const stopEarly = () => {
      if (stopped) return;
      stopped = true;
      try { child.kill('SIGKILL'); } catch (e) { /* already exited */ }
    };

    child.stdout.on('data', (chunk) => {
      if (stopped) return;
      let off = 0;
      while (off < chunk.length) {
        if (current === null) {
          if (frames.length >= count) { stopEarly(); return; }
          current = new Uint8ClampedArray(frameBytes);
          filled = 0;
        }
        const take = Math.min(frameBytes - filled, chunk.length - off);
        current.set(chunk.subarray(off, off + take), filled);
        filled += take;
        off += take;
        if (filled === frameBytes) {
          frames.push(current);
          current = null;
          filled = 0;
          if (frames.length >= count) { stopEarly(); return; }
        }
      }
    });
    // SIGKILL while ffmpeg still has bytes queued closes the pipe under it;
    // the resulting EPIPE is expected and is not a decode failure.
    child.stdout.on('error', () => {});
    child.stderr.on('data', (d) => { stderr = appendStderr(stderr, d); });
    child.stderr.on('error', () => {});

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      current = null; // a trailing partial frame is not a frame
      if (timedOut) {
        reject(new Error(
          `Decoding that video took longer than ${Math.round(timeoutMs / 1000)}s and was stopped. ` +
          'Ask for a shorter trim range, a smaller size, or a lower fps.'
        ));
        return;
      }
      if (!frames.length) {
        reject(new Error(
          `Could not decode any frames from that video in the ${start.toFixed(2)}-${end.toFixed(2)}s trim range ` +
          `(ffmpeg exit code ${code}): ${stderr.trim().slice(-400) || 'no output produced'}`
        ));
        return;
      }
      if (frames.length > count) frames.length = count;
      while (frames.length < count) frames.push(frames[frames.length - 1]);
      resolve(frames);
    });
  });
}

// The order in which frames are written to the file, as indices into the
// forward-sampled array -- [0..n-1] for loop/once, [0..n-1, n-2..1] for
// bounce. This is live-photo.html's bounce step exactly: mirror the middle of
// the clip back onto itself, both endpoints excluded, turning `count` frames
// into 2*count-2. It runs after MAX_FRAMES has already capped `count` and is
// not reapplied, so a bounced GIF can carry up to 238 frames -- matching the
// source precisely, including that asymmetry.
//
// Expressed as INDICES rather than as an expanded frame array because that is
// what lets buildGif tell "the second visit to frame 7" from "frame 7", and so
// quantise each distinct frame exactly once.
function frameOrder(n, motion) {
  const order = [];
  for (let i = 0; i < n; i++) order.push(i);
  if (motion === 'bounce') for (let b = n - 2; b > 0; b--) order.push(b);
  return order;
}

// The same step applied to a frame array, kept because it is the shape the
// browser source states its semantics in. Defined in terms of frameOrder so
// the two can never drift apart. Note what it appends: REFERENCES to frames
// already in the array, never copies -- mirroring has never cost pixels, only
// array slots.
function applyBounce(frames, motion) {
  if (motion !== 'bounce') return frames;
  const order = frameOrder(frames.length, motion);
  for (let k = frames.length; k < order.length; k++) frames.push(frames[order[k]]);
  return frames;
}

async function buildGif({ inputPath, start, end, span, count, width, height, motion, delay, actualFps, fps, speed, maxColors, dither, timeoutMs }) {
  const forward = await extractFrames({ inputPath, start, end, span, count, width, height, timeoutMs });
  const order = frameOrder(forward.length, motion);

  // One shared palette built across every sampled frame at once (not
  // per-frame), exactly like the source -- a clip with wildly different
  // scenes will show banding rather than a palette that flatters only one
  // part of it. The histogram sees the bounced sequence, mirrored middle
  // frames counted twice, because that is what the source feeds it and the
  // resulting palette differs (slightly) if they are counted once.
  const paletteInput = order.map((i) => forward[i]); // an array of references
  const pal = gifEncoder.palette(paletteInput, maxColors);
  paletteInput.length = 0;

  const gifWriter = gifEncoder.writer({ width, height, palette: pal, loop: motion !== 'once' });

  // For bounce, each distinct frame is quantised ONCE and its palette-index
  // bitmap kept for the mirror pass. gifEncoder.map is pure, so replaying the
  // cached indices is byte-identical to re-running it -- but it is a quarter
  // of the size of the RGBA frame it came from and skips a second
  // Floyd-Steinberg pass over the same pixels, which is the most expensive
  // per-pixel work this tool does.
  const indexCache = motion === 'bounce' ? new Array(forward.length).fill(null) : null;

  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    let indices = indexCache ? indexCache[i] : null;
    if (!indices) {
      indices = gifEncoder.map(forward[i], width, height, pal, dither);
      if (indexCache) indexCache[i] = indices;
      // This frame's RGBA pixels are dead the moment its indices exist:
      // loop/once visit each frame once, and bounce replays from the cache.
      // Dropping them here means the RGBA working set shrinks as the (4x
      // smaller) index cache grows, so the peak is the very first frame.
      forward[i] = null;
    }
    gifWriter.frame(indices, delay);
  }
  const frameCount = order.length;
  forward.length = 0;
  order.length = 0;
  if (indexCache) indexCache.length = 0;

  // Every pixel buffer is unreachable by the time the writer's own byte array
  // does its last doubling and final slice, so those two never stack on top of
  // the frames.
  const bytes = gifWriter.finish();
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  return {
    buffer,
    mimeType: 'image/gif',
    filename: 'live-photo.gif',
    stats: {
      format: 'gif',
      frameCount,
      width,
      height,
      byteSize: buffer.length,
      requestedFps: fps,
      actualFps: Math.round(actualFps * 100) / 100,
      delayCentiseconds: delay,
      maxColors,
      dither,
      motion,
      speed,
      trimStart: start,
      trimEnd: end,
      trimSpan: Math.round(span * 1000) / 1000,
      outputPixels: width * height * frameCount,
      maxOutputPixels: MAX_OUTPUT_PIXELS,
    },
  };
}

// mp4/webm output is a deliberate IMPROVEMENT over the source, not a port of
// it: live-photo.html's "video" export is a real-time MediaRecorder capture
// of a <canvas> being repainted frame-by-frame in the browser (it can only
// ever produce whatever codec MediaRecorder.isTypeSupported() picks -- MP4 on
// Safari, WebM elsewhere -- and needs the tab to stay in the foreground for
// the whole recording). There is no server-side encoder to port; this is a
// from-scratch ffmpeg encode of the same trim/scale/speed plan instead, done
// in one pass with no page, no realtime constraint, and a caller-chosen
// container. The source never claims to preserve audio (it is built around
// Live Photos and silent GIF export), so this path drops audio entirely
// (-an) rather than inventing an audio-preserving pipeline the source has no
// equivalent of.
async function buildVideo({ inputPath, start, end, width, height, motion, fps, speed, format, tmpDir, frameCount, timeoutMs }) {
  const outExt = format === 'mp4' ? 'mp4' : 'webm';
  const outputPath = path.join(tmpDir, `output.${outExt}`);
  const scale = `scale=${width}:${height}:flags=lanczos`;
  const speedTerm = speed !== 1 ? `,setpts=PTS/${speed}` : '';

  let args;
  if (motion === 'bounce') {
    // No file-level "loop" flag applies to a real video the way GIF's
    // NETSCAPE2.0 loop extension does, so bounce is the one motion mode that
    // needs its own filter graph: scale+speed the trimmed clip, split it,
    // reverse one copy, and concatenate forward-then-backward -- the same
    // "always meets itself, never cuts" shape the source describes for GIF.
    //
    // `reverse` is the one filter here that buffers: it holds the whole
    // scaled segment in RAM to play it backwards. That is why the pixel
    // budget below is applied to this path too, and why it counts the
    // mirrored frames.
    const filterComplex =
      `[0:v]${scale}${speedTerm}[base];[base]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0[outv]`;
    args = [
      '-y', ...THREAD_ARGS, '-ss', String(start), '-to', String(end), '-i', inputPath,
      '-filter_complex', filterComplex, '-map', '[outv]',
      '-r', String(fps), '-an',
    ];
  } else {
    // 'loop' and 'once' are indistinguishable for a plain video file (there
    // is no in-file repeat instruction to add, unlike GIF's loop extension),
    // so both take the same single-pass trim+scale+speed here.
    args = [
      '-y', ...THREAD_ARGS, '-ss', String(start), '-to', String(end), '-i', inputPath,
      '-vf', scale + speedTerm, '-r', String(fps), '-an',
    ];
  }

  // THREAD_ARGS above pins the DECODER's pools (they sit before -i); the
  // encoder reads -threads from the output options, so it needs its own.
  args.push('-threads', '1');

  if (format === 'mp4') {
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart');
  } else {
    // -cpu-used 4 rather than 2: libvpx-vp9 at cpu-used 2 encodes well under
    // real time on one shared core, which is how a legal 10 s request turns
    // into a Cloudflare 524 that no amount of streaming can rescue. This is a
    // speed/quality knob, not a correctness one, and 4 is still inside the
    // "good" deadline's range.
    args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-deadline', 'good', '-cpu-used', '4');
  }
  args.push(outputPath);

  const { stderr, code, timedOut } = await runFfmpeg(args, { timeoutMs });
  if (timedOut) {
    throw new Error(
      `Encoding that ${outExt} took longer than ${Math.round(timeoutMs / 1000)}s and was stopped. ` +
      'Ask for a shorter trim range, a smaller size, or a lower fps.'
    );
  }
  let outBuf;
  try {
    outBuf = await fsp.readFile(outputPath);
  } catch (err) {
    throw new Error(`ffmpeg (exit code ${code}) did not produce an output file: ${stderr.trim().slice(-400) || err.message}`);
  }
  if (!outBuf.length) {
    throw new Error(`ffmpeg produced an empty ${outExt} file: ${stderr.trim().slice(-400) || 'no diagnostic output'}`);
  }

  const outInfo = await probeVideo(outputPath, 10000).catch(() => null);

  return {
    buffer: outBuf,
    mimeType: format === 'mp4' ? 'video/mp4' : 'video/webm',
    filename: `live-photo.${outExt}`,
    stats: {
      format,
      width: (outInfo && outInfo.width) || width,
      height: (outInfo && outInfo.height) || height,
      byteSize: outBuf.length,
      requestedFps: fps,
      actualFps: fps, // -r forces a constant output rate, so requested == actual here
      durationSeconds: outInfo && outInfo.duration != null ? Math.round(outInfo.duration * 1000) / 1000 : null,
      motion,
      speed,
      outputPixels: width * height * frameCount,
      maxOutputPixels: MAX_OUTPUT_PIXELS,
      audio: 'dropped -- the source tool is silent-GIF/loop focused and defines no audio-preserving path to port',
    },
  };
}

// The largest `size` from SIZES that would bring `frameCount` frames of this
// source's aspect ratio inside MAX_OUTPUT_PIXELS -- so an over-budget request
// gets told what WOULD work instead of just what did not.
function largestFittingSize(sourceWidth, sourceHeight, frameCount) {
  const candidates = SIZES.filter((s) => s > 0).sort((a, b) => b - a);
  for (const s of candidates) {
    const w = Math.max(2, Math.round(s / 2) * 2);
    const h = Math.max(2, Math.round((w * sourceHeight) / sourceWidth / 2) * 2);
    if (w * h * frameCount <= MAX_OUTPUT_PIXELS) return s;
  }
  return null;
}

async function convertVideoToGif(rawInput) {
  // Only endSeconds, videoBase64 and mimeType have no default: there is no
  // sensible trim end to invent, and nothing to convert without the bytes.
  const input = { ...rawInput };
  for (const key of Object.keys(INPUT_DEFAULTS)) {
    if (input[key] === undefined) input[key] = INPUT_DEFAULTS[key];
  }

  const deadline = Date.now() + HARD_DEADLINE_MS;
  const remaining = () => Math.max(1000, deadline - Date.now());

  let buf;
  try {
    buf = byteLimits.decode(input.videoBase64, MAX_INPUT_VIDEO_BYTES);
  } catch (err) {
    if (err instanceof byteLimits.InputTooLargeError) {
      throw new Error(
        `That video is ${(err.actualBytes / 1e6).toFixed(1)} MB; convert_video_to_gif accepts at most ` +
        `${MAX_INPUT_VIDEO_BYTES / 1e6} MB of video per request. (The request body, the parsed JSON and ` +
        'the decoded bytes are all live at once, so a video costs roughly 3.7x its own size before a ' +
        'single frame is decoded.) Trim the clip to just the moment you want, or re-compress it, and ' +
        'send the shorter piece -- this tool only ever samples a few seconds anyway.'
      );
    }
    throw err;
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'goai-video-gif-'));
  const inputPath = path.join(tmpDir, `input.${extFromMime(input.mimeType)}`);

  try {
    await fsp.writeFile(inputPath, buf);
    const probe = await probeVideo(inputPath, Math.min(20000, remaining()));

    let start = input.startSeconds;
    let end = input.endSeconds;
    if (probe.duration != null) {
      start = Math.max(0, Math.min(start, probe.duration));
      end = Math.max(0, Math.min(end, probe.duration));
    } else {
      start = Math.max(0, start);
    }
    const span = end - start;
    // Exact port of the source's `go` handler's opening guard:
    //   if (span < 0.25) { status = tooShort; return; }
    if (!(span >= 0.25)) {
      throw new Error('Drag the handles apart to select at least a quarter of a second (the trim range must be at least 0.25s).');
    }
    if (span > MAX_SPAN_SECONDS) {
      throw new Error(
        `The trim range is ${span.toFixed(2)}s; convert_video_to_gif accepts at most ${MAX_SPAN_SECONDS}s per request ` +
        '(that bound is on how much source video has to be decoded, which is the part that does not get cheaper ' +
        'when you lower size or fps). Send a shorter startSeconds/endSeconds window.'
      );
    }

    const fps = input.fps;
    const speed = input.speed;
    const motion = input.motion;
    const delay = Math.max(2, Math.round(100 / fps));
    const actualFps = 100 / delay;
    const sourceWidth = probe.width;
    const sourceHeight = probe.height;
    // `size: 0` means "keep the source's own width" -- but a 4K phone clip
    // would then set the output to 3840 px wide and blow the pixel budget on
    // two frames, so it is clamped to the widest size this tool offers.
    const wide = Math.min(input.size || sourceWidth, MAX_WIDTH);
    const width = Math.max(2, Math.round(wide / 2) * 2);
    const height = Math.max(2, Math.round((width * sourceHeight) / sourceWidth / 2) * 2);

    const isGif = input.format === 'gif';
    // GIF samples at most MAX_FRAMES frames from the span; mp4/webm has -r
    // forcing a constant output rate, so its frame count follows the span
    // directly and is bounded by the pixel budget alone.
    const rawCount = Math.max(2, Math.round((span * fps) / speed));
    const count = isGif ? Math.min(MAX_FRAMES, rawCount) : rawCount;
    const emittedFrames = motion === 'bounce' ? Math.max(2, count * 2 - 2) : count;
    const outputPixels = width * height * emittedFrames;

    if (outputPixels > MAX_OUTPUT_PIXELS) {
      const fit = largestFittingSize(sourceWidth, sourceHeight, emittedFrames);
      const maxFrames = Math.floor(MAX_OUTPUT_PIXELS / (width * height));
      const maxSpan = (maxFrames * speed) / fps / (motion === 'bounce' ? 2 : 1);
      throw new Error(
        `That request would emit ${width}x${height} x ${emittedFrames} frames = ` +
        `${(outputPixels / 1e6).toFixed(1)} megapixels of animation; convert_video_to_gif allows at most ` +
        `${MAX_OUTPUT_PIXELS / 1e6} megapixels (width x height x frames) so the whole conversion fits a 400 MB ` +
        'container and finishes well inside the 125s proxy timeout. Reduce one of size, fps, speed, motion or ' +
        `the trim span. At ${width}x${height} the limit is ${maxFrames} frames (about ${maxSpan.toFixed(1)}s at ` +
        `fps=${fps}, speed=${speed}${motion === 'bounce' ? ", motion='bounce'" : ''})` +
        (fit ? `, or keep this span and use size=${fit}.` : '.')
      );
    }

    if (isGif) {
      return await buildGif({
        inputPath, start, end, span, count, width, height, motion, delay, actualFps,
        fps, speed, maxColors: input.colours, dither: input.dither, timeoutMs: remaining(),
      });
    }
    return await buildVideo({
      inputPath, start, end, width, height, motion, fps, speed,
      format: input.format, tmpDir, frameCount: emittedFrames, timeoutMs: remaining(),
    });
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// The shape of the JSON in structuredContent. This tool also returns the
// generated file as a separate content block (inline image, embedded
// resource, or a resource_link to GET /files/:token, whichever
// utils/outputStore.js picks); the schema below covers the metadata half
// only, which is what the handler has always put in structuredContent.
const videoGifOutputSchema = {
  format: z.enum(['gif', 'mp4', 'webm']).describe('Output format. This field decides which of the conditional fields below are present.'),
  width: z.number().int().describe('Output width in px.'),
  height: z.number().int().describe('Output height in px.'),
  byteSize: z.number().int().describe('Size of the produced file in bytes.'),
  requestedFps: z.number().describe('The frame rate that was asked for.'),
  actualFps: z
    .number()
    .describe('The frame rate actually achieved, which can differ because frames are sampled by ffmpeg\'s fps filter rather than seeking to exact times.'),
  motion: z.enum(['loop', 'bounce', 'once']).describe('Playback behaviour applied.'),
  speed: z.number().describe('Speed multiplier applied to the source.'),
  outputPixels: z.number().int().describe('Width x height x frames -- the bound that actually governs this tool\'s memory use.'),
  maxOutputPixels: z.number().int().describe('The ceiling outputPixels was checked against, so a rejection is explicable from the result.'),
  // The GIF encoder and the mp4/webm transcode report different things, and
  // the handler returns one shape or the other -- so everything below is
  // conditional on `format` rather than always present.
  frameCount: z.number().int().optional().describe('Number of frames encoded. GIF output only.'),
  delayCentiseconds: z.number().optional().describe('Per-frame delay written into the GIF, in centiseconds. GIF output only.'),
  maxColors: z.number().int().optional().describe('Palette size the median-cut quantiser was allowed. GIF output only.'),
  dither: z.boolean().optional().describe('Whether dithering was applied during quantisation. GIF output only.'),
  trimStart: z.number().optional().describe('Start of the trimmed span in seconds. GIF output only.'),
  trimEnd: z.number().optional().describe('End of the trimmed span in seconds. GIF output only.'),
  trimSpan: z.number().optional().describe('Length of the trimmed span in seconds. GIF output only.'),
  durationSeconds: z.number().optional().describe('Duration of the produced clip in seconds. mp4/webm output only.'),
  audio: z.string().optional().describe('What happened to the source audio track. mp4/webm output only.'),
};

function register(server) {
  server.registerTool(
    'convert_video_to_gif',
    {
      title: 'Trim a short video into a GIF, MP4 or WebM',
      description:
        "Ports GO AI's browser Live Photo-to-GIF tool server-side: trims a SHORT video clip and converts it to an animated GIF, or (a server-side addition the browser tool cannot do) a real MP4/WebM video. " +
        'Input is base64 video bytes plus its mimeType (any container/codec this server\'s ffmpeg build can decode) and a trim range in seconds (startSeconds/endSeconds). ' +
        '\n\nHARD LIMITS -- this runs in a 400 MB container on one shared vCPU behind a proxy that hangs up at 125s, so an over-budget request is REJECTED up front with a message naming the limit rather than accepted and then killed. Read these before calling: ' +
        `(1) the video itself must decode to at most ${MAX_INPUT_VIDEO_BYTES / 1e6} MB -- send a pre-trimmed clip, not a whole recording; ` +
        `(2) the trim range must span at least 0.25s and at most ${MAX_SPAN_SECONDS}s; ` +
        `(3) width x height x frames must not exceed ${MAX_OUTPUT_PIXELS / 1e6} megapixels TOTAL across the whole animation. ` +
        "That third one is the binding limit in practice and it is easy to trip with a portrait clip: at size=480 a 9:16 video is 480x854, so it fits about 29 frames (~2.9s at fps=10) -- while a 16:9 video at the same size is 480x270 and fits the full frame cap. If a call is rejected, the error names the exact frame/size that would fit; do not retry with the same numbers. " +
        `\n\nsize picks the output width in px (0 keeps the source's own width, clamped to ${MAX_WIDTH}; otherwise 720/480/320/240, default 320). Height is derived to preserve aspect ratio and both are forced even (a hard requirement of GIF and most video codecs). ` +
        'fps (10/12/15/20/25, default 10) is the target sampling rate; because GIF frame delays are whole hundredths of a second, the achieved rate (actualFps in the result) is rounded and rarely matches exactly what was requested -- always read actualFps back, do not assume it equals fps. ' +
        'speed (0.5/1/1.5/2) scales playback; speed below 1 samples MORE frames from the same span and so costs more of the pixel budget. ' +
        "motion is loop (plays once per cycle, restarts abruptly), bounce (plays forward then backward so it never visibly cuts -- this roughly DOUBLES the emitted frame count and therefore halves the span that fits the pixel budget), or once (plays through and stops; GIF only, this disables the NETSCAPE2.0 loop extension). " +
        `\n\nFor format 'gif' (the default): at most ${MAX_FRAMES} frames are sampled from the trim range (bounce mirrors the middle back on top of that afterward, so a bounced GIF can carry up to ${MAX_FRAMES * 2 - 2} frames if the pixel budget allows), and colours (256/128/64, default 256) sets the palette size. ` +
        'The palette is a single median-cut palette built across every sampled frame at once, not per frame, exactly like the source -- a clip with wildly different scenes (e.g. a cut between two very different shots) will show banding because the whole clip is sharing one 256-or-fewer-colour palette. dither (default true) enables Floyd-Steinberg dithering, which smooths gradients at the cost of file size and adds visible noise to flat graphics/screen recordings -- turn it off for those. ' +
        "For format 'mp4' (H.264) or 'webm' (VP9): frame sampling and the GIF palette pipeline are skipped entirely and ffmpeg encodes the trimmed/scaled/speed-adjusted clip directly in one pass; audio is always dropped, since the source tool this is ported from is silent-GIF/loop focused and has no audio-preserving path of its own. The same trim-span and pixel limits apply. " +
        'Frame extraction for GIF approximates the source\'s exact evenly-spaced-timestamp sampling with ffmpeg\'s own fps-filter resampling of the decoded stream (documented in code as a deliberate simplification, not a literal port) -- for most clips this is visually indistinguishable, but timing will not be bit-identical to the browser tool\'s output for the same input. ' +
        'Returns the encoded file (inline if small, otherwise a download link) plus a JSON stats object: frameCount (gif only), width, height, byteSize, requestedFps, actualFps, delayCentiseconds (gif only), format, outputPixels, maxOutputPixels, and more. An oversized request, a trim under 0.25s, an undecodable video, or an unsupported codec is reported as a tool error naming the problem, never a crash.',
      annotations: toolAnnotations.PURE,
      outputSchema: videoGifOutputSchema,
      inputSchema: {
        videoBase64: z.string().min(1).describe(`Base64-encoded source video bytes (not a file path or URL). The decoded video must be at most ${MAX_INPUT_VIDEO_BYTES / 1e6} MB; larger payloads are rejected before any decoding happens.`),
        mimeType: z.string().min(1).describe('The source video\'s mime type, e.g. "video/quicktime" or "video/mp4". Used only to pick a temp-file extension; the actual format is content-sniffed by ffmpeg.'),
        startSeconds: z.number().min(0).default(INPUT_DEFAULTS.startSeconds).describe('Trim start, in seconds from the beginning of the video. Clamped to the video\'s own duration.'),
        endSeconds: z.number().gt(0).describe(`Trim end, in seconds. Must leave at least 0.25s and at most ${MAX_SPAN_SECONDS}s between startSeconds and endSeconds.`),
        size: z.literal(SIZES).default(INPUT_DEFAULTS.size).describe(`Output width in px: 0 keeps the source's own width (clamped to ${MAX_WIDTH}); otherwise 720, 480, 320 (default) or 240. Height is derived to preserve aspect ratio; both dimensions are forced even. Bigger sizes buy fewer frames -- width x height x frames is capped at ${MAX_OUTPUT_PIXELS / 1e6} megapixels.`),
        fps: z.literal(FPS).default(INPUT_DEFAULTS.fps).describe('Target sampling/output frame rate: 10 (default), 12, 15, 20 or 25. Higher fps spends the frame budget faster, so it shortens the trim range that will fit. For GIF, the true achieved rate is reported back as actualFps and will differ slightly due to whole-centisecond frame delays.'),
        motion: z.enum(MOTION).default(INPUT_DEFAULTS.motion).describe("'loop' (restarts from the first frame each cycle), 'bounce' (plays forward then backward, never visibly cuts -- roughly doubles the emitted frame count and so halves the span that fits the pixel budget), or 'once' (plays through and stops -- GIF only, disables looping)."),
        speed: z.literal(SPEEDS).default(INPUT_DEFAULTS.speed).describe('Playback speed multiplier: 0.5, 1 (default), 1.5 or 2. Higher speed samples fewer frames per second of source video (and so fits a longer trim); 0.5 samples twice as many.'),
        colours: z.literal(COLOURS).default(INPUT_DEFAULTS.colours).describe('GIF palette size: 256 (default), 128 or 64 shared colours across the whole clip. Ignored for mp4/webm.'),
        dither: z.boolean().default(INPUT_DEFAULTS.dither).describe('Floyd-Steinberg dithering for the GIF palette (default true). Smooths gradients at the cost of file size and adds noise to flat graphics -- turn off for screen recordings or flat artwork. Ignored for mp4/webm.'),
        format: z.enum(['gif', 'mp4', 'webm']).default(INPUT_DEFAULTS.format).describe("Output container. 'gif' (default) runs the full sampling + shared-palette + LZW pipeline. 'mp4' (H.264) and 'webm' (VP9) skip that pipeline and have ffmpeg encode the trimmed/scaled/speed-adjusted clip directly, with audio always dropped."),
      },
    },
    async (args) => {
      try {
        const result = await convertVideoToGif(args);
        const bin = outputStore.emitBinaryOutput({ buffer: result.buffer, mimeType: result.mimeType, filename: result.filename });
        const meta = toolResult.ok(result.stats);
        return { content: [...meta.content, ...bin.content], structuredContent: meta.structuredContent };
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );
}

module.exports = {
  register,
  toolCount: 1,
  convertVideoToGif,
  INPUT_DEFAULTS,
  extractFrames,
  applyBounce,
  frameOrder,
  probeVideo,
  extFromMime,
  largestFittingSize,
  SIZES,
  FPS,
  COLOURS,
  SPEEDS,
  MOTION,
  MAX_FRAMES,
  MAX_SPAN_SECONDS,
  MAX_WIDTH,
  MAX_OUTPUT_PIXELS,
  MAX_INPUT_VIDEO_BYTES,
  HARD_DEADLINE_MS,
};
