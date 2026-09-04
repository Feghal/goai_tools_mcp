'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const sharp = require('sharp');
const { z } = require('zod');

// Each real call here runs at least one ffmpeg process end-to-end (probe +
// decode + encode); under this sandboxed test environment that reliably
// costs more than Jest's default 5s per-test budget, especially for tests
// that make more than one such call. Bumped per-test below rather than
// globally, since most of this suite's non-ffmpeg tests are fast.
const FFMPEG_TEST_TIMEOUT_MS = 60000;

const gifEncoder = require('../utils/gifEncoder');
const mod = require('../controllers/tools/video-gif');
const {
  register,
  toolCount,
  convertVideoToGif,
  extractFrames,
  applyBounce,
  frameOrder,
  largestFittingSize,
  extFromMime,
  SIZES,
  FPS,
  MAX_FRAMES,
  MAX_SPAN_SECONDS,
  MAX_WIDTH,
  MAX_OUTPUT_PIXELS,
  MAX_INPUT_VIDEO_BYTES,
} = mod;

// No committed binary fixture: real test videos are generated once, in this
// suite's own setup, with ffmpeg's own lavfi testsrc -- a silent, synthetic
// video source with no external dependency. A second, separately-timed clip
// gives the trim-range guard something real to reject.
let clipBuffer; // 2s, 320x240, 15fps, no audio
let tinyClipBuffer; // 0.5s clip, used to exercise the too-short trim guard
let portraitBuffer; // 3.5s, 720x1280 -- big enough to actually reach MAX_OUTPUT_PIXELS
let longBuffer; // 12s, 160x120 -- long enough to actually exceed MAX_SPAN_SECONDS
let wideBuffer; // 1s, 1280x720 -- wider than MAX_WIDTH, for the size:0 clamp

beforeAll(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-gif-test-'));
  const make = (name, filter) => {
    const p = path.join(tmpDir, name);
    execFileSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', filter, '-pix_fmt', 'yuv420p', p], { stdio: 'pipe' });
    return fs.readFileSync(p);
  };

  clipBuffer = make('clip.mp4', 'testsrc=duration=2:size=320x240:rate=15');
  tinyClipBuffer = make('tiny.mp4', 'testsrc=duration=0.5:size=320x240:rate=15');
  portraitBuffer = make('portrait.mp4', 'testsrc=duration=3.5:size=720x1280:rate=15');
  longBuffer = make('long.mp4', 'testsrc=duration=12:size=160x120:rate=10');
  wideBuffer = make('wide.mp4', 'testsrc=duration=1:size=1280x720:rate=15');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}, FFMPEG_TEST_TIMEOUT_MS);

function b64(buf) {
  return buf.toString('base64');
}

function baseArgs(overrides) {
  return Object.assign(
    {
      videoBase64: b64(clipBuffer),
      mimeType: 'video/mp4',
      startSeconds: 0,
      endSeconds: 1.5,
      size: 320,
      fps: 15,
      motion: 'loop',
      speed: 1,
      colours: 256,
      dither: true,
      format: 'gif',
    },
    overrides
  );
}

// Parses width/height/duration out of `ffmpeg -i <file>` stderr -- the same
// technique the tool itself uses to probe input, applied here in the test to
// independently confirm what actually landed on disk for mp4/webm output.
function ffprobeViaStderr(filePath) {
  let stderr = '';
  try {
    execFileSync(ffmpegPath, ['-i', filePath], { stdio: 'pipe' });
  } catch (err) {
    stderr = err.stderr ? err.stderr.toString('utf8') : '';
  }
  const res = stderr.match(/Video:[^\n]*?(\d{2,5})x(\d{2,5})/);
  const dur = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return {
    width: res ? parseInt(res[1], 10) : null,
    height: res ? parseInt(res[2], 10) : null,
    duration: dur ? +dur[1] * 3600 + +dur[2] * 60 + parseFloat(dur[3]) : null,
    stderr,
  };
}

function registeredTool() {
  const captured = {};
  register({ registerTool: (name, def, handler) => { captured.name = name; captured.def = def; captured.handler = handler; } });
  return captured;
}

describe('extFromMime', () => {
  test('maps common video mime types to extensions and falls back to bin', () => {
    expect(extFromMime('video/quicktime')).toBe('mov');
    expect(extFromMime('video/mp4')).toBe('mp4');
    expect(extFromMime('video/webm')).toBe('webm');
    expect(extFromMime('application/octet-stream')).toBe('bin');
  });
});

describe('convertVideoToGif: gif output', () => {
  test('produces a real, valid GIF: correct signature, dimensions and frame count (re-decoded with sharp)', async () => {
    const result = await convertVideoToGif(baseArgs());

    expect(result.mimeType).toBe('image/gif');
    expect(result.buffer.slice(0, 6).toString('ascii')).toBe('GIF89a');
    expect(result.buffer.readUInt16LE(6)).toBe(result.stats.width);
    expect(result.buffer.readUInt16LE(8)).toBe(result.stats.height);

    const meta = await sharp(result.buffer, { animated: true }).metadata();
    expect(meta.width).toBe(result.stats.width);
    expect(meta.pageHeight).toBe(result.stats.height);
    expect(meta.pages).toBe(result.stats.frameCount);

    expect(result.stats.width).toBe(320);
    expect(result.stats.height).toBe(240); // source is already 320x240, so it round-trips unchanged
    expect(result.stats.width % 2).toBe(0);
    expect(result.stats.height % 2).toBe(0);

    // span=1.5s, fps=15, speed=1 -> round(1.5*15/1) = 23 frames
    expect(result.stats.frameCount).toBe(23);
    expect(result.stats.delayCentiseconds).toBe(Math.max(2, Math.round(100 / 15)));
    expect(result.stats.actualFps).toBeCloseTo(100 / result.stats.delayCentiseconds, 2);

    // The bound the caller was measured against travels back with the result,
    // so an agent that got a rejection can see how close a success was.
    expect(result.stats.outputPixels).toBe(320 * 240 * 23);
    expect(result.stats.maxOutputPixels).toBe(MAX_OUTPUT_PIXELS);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('bounce motion mirrors the middle frames, turning count frames into 2*count-2', async () => {
    const plain = await convertVideoToGif(baseArgs({ motion: 'loop' }));
    const bounced = await convertVideoToGif(baseArgs({ motion: 'bounce' }));

    expect(bounced.stats.frameCount).toBe(plain.stats.frameCount * 2 - 2);
    const meta = await sharp(bounced.buffer, { animated: true }).metadata();
    expect(meta.pages).toBe(bounced.stats.frameCount);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('never exceeds MAX_FRAMES sampled frames before bounce mirroring, even for a long span at high fps', async () => {
    // 2s clip at 25fps would ask for 50 frames, well under the cap -- use a
    // low speed to push the raw request over MAX_FRAMES instead.
    // round(span*fps/speed) = round(2*25/0.5) = 100.
    const result = await convertVideoToGif(baseArgs({ endSeconds: 2, fps: 25, speed: 0.5, motion: 'once' }));
    expect(result.stats.frameCount).toBeLessThanOrEqual(MAX_FRAMES);
    expect(result.stats.frameCount).toBe(100);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('MAX_FRAMES actually clamps a request that asks for more than it', async () => {
    // 12s of 160x120 is only 0.02 Mpx a frame, so the pixel budget cannot be
    // what stops this one: round(10*25/0.5) = 500 frames, clamped to the cap.
    const result = await convertVideoToGif(
      baseArgs({ videoBase64: b64(longBuffer), endSeconds: 10, size: 240, fps: 25, speed: 0.5, motion: 'once' })
    );
    expect(result.stats.frameCount).toBe(MAX_FRAMES);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('size=0 keeps the source width (both dimensions still forced even)', async () => {
    const result = await convertVideoToGif(baseArgs({ size: 0 }));
    expect(result.stats.width).toBe(320); // source width, already even
    expect(result.stats.height).toBe(240);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('size=0 on a source wider than MAX_WIDTH clamps to MAX_WIDTH instead of inheriting it', async () => {
    // Without the clamp a 4K phone clip would set the output to 3840px wide
    // and blow the whole pixel budget on two frames.
    const result = await convertVideoToGif(
      baseArgs({ videoBase64: b64(wideBuffer), size: 0, endSeconds: 1, fps: 10 })
    );
    expect(result.stats.width).toBe(MAX_WIDTH);
    expect(result.stats.width).toBeLessThan(1280);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('dither:false and dither:true produce different (valid) byte streams for the same input', async () => {
    const plain = await convertVideoToGif(baseArgs({ dither: false }));
    const dithered = await convertVideoToGif(baseArgs({ dither: true }));
    expect(plain.buffer.slice(0, 6).toString('ascii')).toBe('GIF89a');
    expect(dithered.buffer.slice(0, 6).toString('ascii')).toBe('GIF89a');
    expect(Buffer.compare(plain.buffer, dithered.buffer)).not.toBe(0);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('a trim shorter than 0.25s is rejected with a clean error, not a crash', async () => {
    await expect(convertVideoToGif(baseArgs({ videoBase64: b64(tinyClipBuffer), startSeconds: 0.1, endSeconds: 0.2 })))
      .rejects.toThrow(/at least a quarter of a second/);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('endSeconds beyond the real duration is clamped to it rather than erroring', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-gif-probe-'));
    const tinyPath = path.join(tmp, 'tiny.mp4');
    fs.writeFileSync(tinyPath, tinyClipBuffer);
    const realDuration = ffprobeViaStderr(tinyPath).duration;
    fs.rmSync(tmp, { recursive: true, force: true });

    const result = await convertVideoToGif(baseArgs({ videoBase64: b64(tinyClipBuffer), startSeconds: 0, endSeconds: 999 }));
    expect(result.stats.trimEnd).toBeCloseTo(realDuration, 1);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('a corrupt / non-video payload is rejected with a clean error, not an uncaught exception', async () => {
    const garbage = Buffer.from('this is definitely not a video file, just plain text bytes repeated a bit');
    await expect(convertVideoToGif(baseArgs({ videoBase64: b64(garbage) })))
      .rejects.toThrow(/could not be read as a video/i);
  }, FFMPEG_TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// The resource envelope. Every one of these is the difference between a clean
// rejection and a request that gets accepted and then OOM-killed in a 400 MB
// container (or cut off by a 125s edge timeout it cannot be told about).
// ---------------------------------------------------------------------------
describe('convertVideoToGif: resource bounds', () => {
  // 720x1280 source at size=720 is 921,600 px a frame, so 13 frames is
  // 11.98 Mpx (inside the 12 Mpx cap) and 14 is 12.90 Mpx (outside it).
  // count = round(span * fps / speed), so span picks the frame count exactly.
  const AT_LIMIT_FRAMES = Math.floor(MAX_OUTPUT_PIXELS / (720 * 1280));

  test('the pixel budget accepts a request sitting exactly on the limit', async () => {
    const span = AT_LIMIT_FRAMES / 10; // fps=10, speed=1 -> count === AT_LIMIT_FRAMES
    const result = await convertVideoToGif(
      baseArgs({ videoBase64: b64(portraitBuffer), size: 720, fps: 10, endSeconds: span, motion: 'once' })
    );
    expect(result.stats.width).toBe(720);
    expect(result.stats.height).toBe(1280);
    expect(result.stats.frameCount).toBe(AT_LIMIT_FRAMES);
    expect(result.stats.outputPixels).toBeLessThanOrEqual(MAX_OUTPUT_PIXELS);
    // and it really is a limit, not a rounding coincidence
    expect(result.stats.outputPixels + 720 * 1280).toBeGreaterThan(MAX_OUTPUT_PIXELS);
    expect(result.buffer.slice(0, 6).toString('ascii')).toBe('GIF89a');
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('one frame past the pixel budget is rejected by name, with a size that would fit', async () => {
    const span = (AT_LIMIT_FRAMES + 1) / 10;
    const call = convertVideoToGif(
      baseArgs({ videoBase64: b64(portraitBuffer), size: 720, fps: 10, endSeconds: span, motion: 'once' })
    );
    await expect(call).rejects.toThrow(/megapixels/);
    await expect(call).rejects.toThrow(new RegExp(`at most ${MAX_OUTPUT_PIXELS / 1e6} megapixels`));
    await expect(call).rejects.toThrow(/use size=\d+/);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test("the tool's OWN previous defaults (size 480, fps 15) on a portrait clip are now rejected", async () => {
    // This is the combination that measured 848 MB peak RSS and was OOM-killed
    // in a 400 MB container: 480x854 x 45 frames = 18.4 Mpx.
    await expect(
      convertVideoToGif(baseArgs({ videoBase64: b64(portraitBuffer), size: 480, fps: 15, endSeconds: 3 }))
    ).rejects.toThrow(/megapixels/);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('bounce is charged for its mirrored frames, so it halves the span that fits', async () => {
    // count frames become 2*count-2 in the file, and the budget counts what is
    // written, not what was sampled.
    const span = AT_LIMIT_FRAMES / 10; // fits comfortably as 'once'
    await expect(
      convertVideoToGif(baseArgs({ videoBase64: b64(portraitBuffer), size: 720, fps: 10, endSeconds: span, motion: 'bounce' }))
    ).rejects.toThrow(/megapixels/);

    const half = Math.floor((AT_LIMIT_FRAMES + 2) / 2) / 10;
    const ok = await convertVideoToGif(
      baseArgs({ videoBase64: b64(portraitBuffer), size: 720, fps: 10, endSeconds: half, motion: 'bounce' })
    );
    expect(ok.stats.outputPixels).toBeLessThanOrEqual(MAX_OUTPUT_PIXELS);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test(`a trim span over MAX_SPAN_SECONDS (${MAX_SPAN_SECONDS}s) is rejected by name`, async () => {
    await expect(
      convertVideoToGif(baseArgs({ videoBase64: b64(longBuffer), size: 240, fps: 10, startSeconds: 0, endSeconds: 12 }))
    ).rejects.toThrow(new RegExp(`at most ${MAX_SPAN_SECONDS}s per request`));
  }, FFMPEG_TEST_TIMEOUT_MS);

  test(`a span of exactly MAX_SPAN_SECONDS is still accepted`, async () => {
    const result = await convertVideoToGif(
      baseArgs({ videoBase64: b64(longBuffer), size: 240, fps: 10, startSeconds: 0, endSeconds: MAX_SPAN_SECONDS, motion: 'once' })
    );
    expect(result.stats.trimSpan).toBeCloseTo(MAX_SPAN_SECONDS, 1);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('an input over MAX_INPUT_VIDEO_BYTES is rejected before anything is decoded', async () => {
    // byteLimits.decode sizes the payload from the base64 STRING, so this
    // never allocates the buffer it is refusing -- no ffmpeg process is spawned
    // and no temp file is written.
    const oversizedChars = Math.ceil(((MAX_INPUT_VIDEO_BYTES + 2 * 1000 * 1000) * 4) / 3);
    const payload = 'A'.repeat(oversizedChars);
    await expect(convertVideoToGif(baseArgs({ videoBase64: payload })))
      .rejects.toThrow(new RegExp(`at most ${MAX_INPUT_VIDEO_BYTES / 1e6} MB of video`));
  });

  test('an input just under MAX_INPUT_VIDEO_BYTES gets past the size gate', async () => {
    // Junk bytes, so it fails at "not a video" -- which proves the size gate
    // let it through rather than short-circuiting on length.
    const okChars = Math.floor(((MAX_INPUT_VIDEO_BYTES - 1000 * 1000) * 4) / 3);
    await expect(convertVideoToGif(baseArgs({ videoBase64: 'A'.repeat(okChars) })))
      .rejects.toThrow(/could not be read as a video/i);
  }, FFMPEG_TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// The memory-shape contract. These do not measure RSS (Jest cannot usefully do
// that), they pin the ALLOCATION BEHAVIOUR that the measured numbers depend
// on: one copy of the pixels, and one quantisation pass per distinct frame.
// ---------------------------------------------------------------------------
describe('memory shape', () => {
  test('extractFrames returns exactly `count` frames, each its own exactly-sized buffer', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-gif-extract-'));
    const clipPath = path.join(tmp, 'clip.mp4');
    fs.writeFileSync(clipPath, clipBuffer);
    try {
      const frames = await extractFrames({
        inputPath: clipPath, start: 0, end: 1.5, span: 1.5, count: 12, width: 64, height: 48, timeoutMs: 30000,
      });
      expect(frames).toHaveLength(12);
      for (const f of frames) {
        expect(f).toBeInstanceOf(Uint8ClampedArray);
        expect(f.length).toBe(64 * 48 * 4);
        // Its own buffer, exactly the frame's size -- not a view onto one big
        // concatenated stdout buffer that would keep the whole thing alive.
        expect(f.byteOffset).toBe(0);
        expect(f.buffer.byteLength).toBe(64 * 48 * 4);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('extractFrames honours `count` exactly whether ffmpeg over- or under-supplies', async () => {
    // The frame count is normalised on both sides: ffmpeg's fps filter is asked
    // for count/span and lands near but not exactly on `count`, so extras are
    // never even read off the pipe (ffmpeg is killed once the last wanted frame
    // lands) and a short decode is padded by repeating the last frame BY
    // REFERENCE. In practice the fps filter duplicates source frames to hit its
    // target, so it is the over-supply side that fires; the pad is a rounding
    // backstop. Either way the caller gets exactly `count`.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-gif-count-'));
    const clipPath = path.join(tmp, 'tiny.mp4');
    fs.writeFileSync(clipPath, tinyClipBuffer); // 0.5s of 15fps source
    try {
      for (const [start, end, count] of [[0, 0.4, 40], [0, 0.5, 200], [0.45, 0.5, 30], [0, 0.5, 2]]) {
        const frames = await extractFrames({
          inputPath: clipPath, start, end, span: end - start, count, width: 32, height: 24, timeoutMs: 30000,
        });
        expect(frames).toHaveLength(count);
        // No frame is a window onto a bigger buffer, so none of them is keeping
        // a whole concatenated decode alive.
        for (const f of frames) expect(f.buffer.byteLength).toBe(32 * 24 * 4);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('applyBounce appends references to existing frames, never copies of them', () => {
    const frames = [1, 2, 3, 4].map((n) => new Uint8ClampedArray([n]));
    const before = frames.slice();
    const out = applyBounce(frames, 'bounce');
    expect(out).toHaveLength(6); // 2*4-2
    expect(out[4]).toBe(before[2]);
    expect(out[5]).toBe(before[1]);
  });

  test('frameOrder lists the write order as indices, so a repeat is recognisable as a repeat', () => {
    expect(frameOrder(4, 'loop')).toEqual([0, 1, 2, 3]);
    expect(frameOrder(4, 'once')).toEqual([0, 1, 2, 3]);
    expect(frameOrder(4, 'bounce')).toEqual([0, 1, 2, 3, 2, 1]);
    expect(frameOrder(2, 'bounce')).toEqual([0, 1]);
  });

  test('frameOrder and applyBounce describe the same sequence', () => {
    for (const n of [2, 3, 4, 7, 23]) {
      const frames = Array.from({ length: n }, (_, i) => new Uint8ClampedArray([i]));
      const expanded = applyBounce(frames.slice(), 'bounce');
      const viaOrder = frameOrder(n, 'bounce').map((i) => frames[i]);
      expect(expanded).toEqual(viaOrder);
      expect(expanded).toHaveLength(n === 2 ? 2 : n * 2 - 2);
    }
  });

  test('a bounced GIF quantises each distinct frame ONCE, while the palette still sees the mirrored sequence', async () => {
    // The Floyd-Steinberg pass is the most expensive per-pixel work here, and
    // the mirrored half is the same pixels again. Encoding them twice was both
    // a second full set of RGBA frames and a second dithering pass; the cache
    // removes both without changing a byte of output (gifEncoder.map is pure).
    const realPalette = gifEncoder.palette;
    const mapSpy = jest.spyOn(gifEncoder, 'map');
    // Recorded AT CALL TIME, not from mock.calls: buildGif empties the array it
    // handed to palette() the moment palette() returns, precisely so that
    // nothing but `forward` still points at the frames and dropping them there
    // really frees them. A spy that read mock.calls afterwards would see an
    // empty array -- and a spy that HELD the frames would defeat the thing this
    // test exists to protect.
    let paletteSawFrames = null;
    const paletteSpy = jest.spyOn(gifEncoder, 'palette').mockImplementation((frames, maxColors) => {
      paletteSawFrames = frames.length;
      return realPalette(frames, maxColors);
    });
    try {
      const result = await convertVideoToGif(baseArgs({ motion: 'bounce' }));
      const written = result.stats.frameCount;      // 2*count-2
      const distinct = (written + 2) / 2;           // count

      expect(mapSpy).toHaveBeenCalledTimes(distinct);
      expect(mapSpy.mock.calls.length).toBeLessThan(written);
      // ...but the histogram is still fed the full mirrored sequence, because
      // double-counting the middle frames is what the browser source does and
      // it changes the palette.
      expect(paletteSpy).toHaveBeenCalledTimes(1);
      expect(paletteSawFrames).toBe(written);
    } finally {
      mapSpy.mockRestore();
      paletteSpy.mockRestore();
    }
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('a non-bounced GIF quantises exactly once per frame and keeps no index cache', async () => {
    const mapSpy = jest.spyOn(gifEncoder, 'map');
    try {
      const result = await convertVideoToGif(baseArgs({ motion: 'loop' }));
      expect(mapSpy).toHaveBeenCalledTimes(result.stats.frameCount);
    } finally {
      mapSpy.mockRestore();
    }
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('largestFittingSize names a size from SIZES that really does fit', () => {
    // 9:16 source, 29 frames: 480x854 fits (11.9 Mpx), 720x1280 does not.
    const fit = largestFittingSize(1080, 1920, 29);
    expect(SIZES).toContain(fit);
    const w = Math.round(fit / 2) * 2;
    const h = Math.round((w * 1920) / 1080 / 2) * 2;
    expect(w * h * 29).toBeLessThanOrEqual(MAX_OUTPUT_PIXELS);
    expect(largestFittingSize(1080, 1920, 1)).toBe(Math.max(...SIZES));
    // Nothing on offer can fit an absurd frame count.
    expect(largestFittingSize(1080, 1920, 100000)).toBeNull();
  });
});

describe('convertVideoToGif: mp4/webm output', () => {
  test('mp4 output is a real, valid H.264 file with the requested dimensions', async () => {
    const result = await convertVideoToGif(baseArgs({ format: 'mp4', size: 320, speed: 1.5 }));
    expect(result.mimeType).toBe('video/mp4');
    expect(result.filename).toMatch(/\.mp4$/);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-gif-out-'));
    const outPath = path.join(tmp, 'out.mp4');
    fs.writeFileSync(outPath, result.buffer);
    const probed = ffprobeViaStderr(outPath);
    fs.rmSync(tmp, { recursive: true, force: true });

    expect(probed.width).toBe(320);
    expect(probed.height).toBe(240);
    expect(probed.stderr).toMatch(/h264/i);
    expect(probed.duration).toBeGreaterThan(0);
    // 1.5s trim at 1.5x speed should land near 1.0s -- allow generous slack
    // for input-side seek/keyframe rounding (documented approximation).
    expect(probed.duration).toBeLessThan(1.5);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('webm output is a real, valid VP9 file, and bounce roughly doubles its duration', async () => {
    const plain = await convertVideoToGif(baseArgs({ format: 'webm', motion: 'loop' }));
    const bounced = await convertVideoToGif(baseArgs({ format: 'webm', motion: 'bounce' }));
    expect(plain.mimeType).toBe('video/webm');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-gif-out-'));
    const plainPath = path.join(tmp, 'plain.webm');
    const bouncedPath = path.join(tmp, 'bounced.webm');
    fs.writeFileSync(plainPath, plain.buffer);
    fs.writeFileSync(bouncedPath, bounced.buffer);
    const plainProbe = ffprobeViaStderr(plainPath);
    const bouncedProbe = ffprobeViaStderr(bouncedPath);
    fs.rmSync(tmp, { recursive: true, force: true });

    expect(plainProbe.stderr).toMatch(/vp9/i);
    expect(plainProbe.width).toBe(320);
    expect(bouncedProbe.duration).toBeGreaterThan(plainProbe.duration * 1.7);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('mp4/webm stats report audio as deliberately dropped', async () => {
    const result = await convertVideoToGif(baseArgs({ format: 'mp4' }));
    expect(result.stats.audio).toMatch(/dropped/i);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('the pixel budget applies to mp4/webm too -- ffmpeg is not a way around it', async () => {
    // The video path has no MAX_FRAMES clamp (its length follows the span, not
    // a sample count), so without the pixel check a 10s 720p request would
    // hand libvpx far more work than 125s of one shared vCPU can finish.
    await expect(
      convertVideoToGif(baseArgs({ videoBase64: b64(portraitBuffer), size: 720, fps: 25, endSeconds: 3, format: 'webm' }))
    ).rejects.toThrow(/megapixels/);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('mp4/webm results carry the same outputPixels/maxOutputPixels budget readout as gif', async () => {
    const result = await convertVideoToGif(baseArgs({ format: 'mp4' }));
    expect(result.stats.maxOutputPixels).toBe(MAX_OUTPUT_PIXELS);
    expect(result.stats.outputPixels).toBeGreaterThan(0);
    expect(result.stats.outputPixels).toBeLessThanOrEqual(MAX_OUTPUT_PIXELS);
  }, FFMPEG_TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------

describe('convertVideoToGif: defaults are the function\'s own, not only the schema\'s', () => {
  // The MCP path parses through zod, which fills every optional argument in.
  // Any other caller -- a test, a future internal caller, another module --
  // does not, and the failure that produced was silent: with `colours`
  // undefined, gifEncoder.palette()'s `while (boxes.length < maxColors)` is
  // false on its first test, so the call SUCCEEDED and returned a GIF with a
  // 2-colour global colour table.
  const gctEntries = (buf) => {
    // GIF89a logical screen descriptor: byte 10 bit 7 is "has global colour
    // table", bits 0-2 are log2(size) - 1.
    expect(buf[10] & 0x80).toBe(0x80);
    return 2 ** ((buf[10] & 0x07) + 1);
  };

  test('a bare call gets the full palette, not a 2-colour one', async () => {
    const result = await convertVideoToGif({
      videoBase64: b64(clipBuffer),
      mimeType: 'video/mp4',
      endSeconds: 1,
    });
    expect(result.stats.maxColors).toBe(mod.INPUT_DEFAULTS.colours);
    expect(gctEntries(result.buffer)).toBe(256);
    // ...and the rest of the defaults reached the encoder too, rather than
    // startSeconds being undefined and turning the trim span into NaN.
    expect(result.stats.width).toBe(mod.INPUT_DEFAULTS.size);
    expect(result.stats.format).toBe(mod.INPUT_DEFAULTS.format);
    expect(result.stats.trimStart).toBe(0);
    expect(result.stats.trimSpan).toBe(1);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('an explicit value still wins over the default', async () => {
    const result = await convertVideoToGif(baseArgs({ colours: 64, size: 240 }));
    expect(result.stats.maxColors).toBe(64);
    expect(gctEntries(result.buffer)).toBe(64);
    expect(result.stats.width).toBe(240);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('the schema quotes INPUT_DEFAULTS rather than restating the numbers', () => {
    const shape = registeredTool().def.inputSchema;
    const parsed = z.object(shape).parse({ videoBase64: 'x', mimeType: 'video/mp4', endSeconds: 1 });
    for (const [key, value] of Object.entries(mod.INPUT_DEFAULTS)) {
      expect(parsed[key]).toBe(value);
    }
  });
});

// ---------------------------------------------------------------------------

describe('register()', () => {
  test('registers exactly one tool named convert_video_to_gif', () => {
    expect(toolCount).toBe(1);
    const registered = [];
    const fakeServer = { registerTool: (name, def, handler) => registered.push({ name, def, handler }) };
    register(fakeServer);
    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe('convert_video_to_gif');
    expect(typeof registered[0].handler).toBe('function');
  });

  test('the schema defaults are the small ones, not the ones that used to OOM', () => {
    const { def } = registeredTool();
    const parsed = z.object(def.inputSchema).parse({ videoBase64: 'AA==', mimeType: 'video/mp4', endSeconds: 1 });
    expect(parsed.size).toBe(320);   // was 480
    expect(parsed.fps).toBe(10);     // was 15
    expect(parsed.motion).toBe('loop');
    expect(parsed.speed).toBe(1);
    expect(parsed.colours).toBe(256);
    expect(parsed.dither).toBe(true);
    expect(parsed.format).toBe('gif');
    expect(parsed.startSeconds).toBe(0);
  });

  test('the schema itself refuses sizes and rates the box cannot afford', () => {
    const { def } = registeredTool();
    const schema = z.object(def.inputSchema);
    const ok = { videoBase64: 'AA==', mimeType: 'video/mp4', endSeconds: 1 };
    expect(SIZES).not.toContain(1080);
    expect(schema.safeParse({ ...ok, size: 1080 }).success).toBe(false);
    expect(schema.safeParse({ ...ok, size: 2000 }).success).toBe(false);
    expect(schema.safeParse({ ...ok, fps: 60 }).success).toBe(false);
    for (const s of SIZES) expect(schema.safeParse({ ...ok, size: s }).success).toBe(true);
    for (const f of FPS) expect(schema.safeParse({ ...ok, fps: f }).success).toBe(true);
  });

  test('the description teaches the limits, so a calling agent can stay inside them', () => {
    const { def } = registeredTool();
    expect(def.description).toContain(`${MAX_OUTPUT_PIXELS / 1e6} megapixels`);
    expect(def.description).toContain(`${MAX_SPAN_SECONDS}s`);
    expect(def.description).toContain(`${MAX_INPUT_VIDEO_BYTES / 1e6} MB`);
    expect(def.inputSchema.size.description).toMatch(/megapixels/);
    expect(def.inputSchema.endSeconds.description).toMatch(new RegExp(`${MAX_SPAN_SECONDS}s`));
    expect(def.inputSchema.videoBase64.description).toMatch(new RegExp(`${MAX_INPUT_VIDEO_BYTES / 1e6} MB`));
  });

  test('a real call returns MCP content blocks and structuredContent stats, no isError', async () => {
    const { handler } = registeredTool();
    const res = await handler(baseArgs());
    expect(res.isError).toBeUndefined();
    expect(Array.isArray(res.content)).toBe(true);
    expect(res.structuredContent.format).toBe('gif');
    expect(res.structuredContent.frameCount).toBeGreaterThan(0);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('an expected input problem (too-short trim) comes back as isError, not a thrown exception', async () => {
    const { handler } = registeredTool();
    const res = await handler(baseArgs({ videoBase64: b64(tinyClipBuffer), startSeconds: 0, endSeconds: 0.1 }));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/quarter of a second/);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('an over-budget request comes back as isError naming the limit, never as an OOM', async () => {
    const { handler } = registeredTool();
    const res = await handler(baseArgs({ videoBase64: b64(portraitBuffer), size: 720, fps: 15, endSeconds: 3 }));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/megapixels/);
  }, FFMPEG_TEST_TIMEOUT_MS);

  test('a corrupt payload comes back as isError, not a thrown exception', async () => {
    const { handler } = registeredTool();
    const res = await handler(baseArgs({ videoBase64: b64(Buffer.from('not a video')) }));
    expect(res.isError).toBe(true);
  }, FFMPEG_TEST_TIMEOUT_MS);
});
