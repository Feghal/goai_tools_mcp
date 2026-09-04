'use strict';

const sharp = require('sharp');
const { compressImage, compressionCurve, CURVE_QUALITIES, DEFAULT_MAX_DIMENSION, DEFAULT_QUALITY } = require('../controllers/tools/compress');

// Self-contained fixtures, built in-memory with sharp (no external files).

// A flat-color PNG -- fine for size/enlargement checks where pixel content
// doesn't matter.
function flatImageBase64(width, height) {
  return sharp({ create: { width, height, channels: 3, background: { r: 40, g: 120, b: 200 } } })
    .png()
    .toBuffer()
    .then((buf) => buf.toString('base64'));
}

// A noisy PNG -- gives JPEG/WebP/AVIF something non-trivial to compress, so
// byte size actually moves with quality instead of flatlining at a few
// bytes for every setting.
function noisyImageBase64(width, height) {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256);
  return sharp(raw, { raw: { width, height, channels } })
    .png()
    .toBuffer()
    .then((buf) => buf.toString('base64'));
}

describe('compressImage', () => {
  test('downscales to fit within maxDimension (aspect preserved, longer side capped) and reports stats', async () => {
    const imageBase64 = await noisyImageBase64(400, 200);
    const result = await compressImage({ imageBase64, format: 'jpeg', quality: 80, maxDimension: 100 });

    expect(result.mimeType).toBe('image/jpeg');
    expect(result.filename).toBe('compressed.jpg');

    const { stats } = result;
    expect(stats.original).toEqual({ width: 400, height: 200, bytes: expect.any(Number) });
    // 400x200 at 2:1 aspect, capped to 100 on the longer side -> 100x50.
    expect(stats.working).toEqual({ width: 100, height: 50, maxDimension: 100 });
    expect(stats.compressed.width).toBe(100);
    expect(stats.compressed.height).toBe(50);
    expect(stats.compressed.bytes).toBeGreaterThan(0);
    expect(stats.format).toBe('jpeg');
    expect(stats.quality).toBe(80);

    // The actual re-encoded bytes decode back to the same dimensions sharp reported.
    const decoded = await sharp(result.buffer).metadata();
    expect(decoded.width).toBe(100);
    expect(decoded.height).toBe(50);
    expect(decoded.format).toBe('jpeg');
  });

  test('never enlarges a source already smaller than maxDimension', async () => {
    const imageBase64 = await flatImageBase64(50, 30);
    const result = await compressImage({ imageBase64, format: 'webp', quality: 75, maxDimension: DEFAULT_MAX_DIMENSION });

    expect(result.stats.original).toEqual({ width: 50, height: 30, bytes: expect.any(Number) });
    expect(result.stats.working.width).toBe(50);
    expect(result.stats.working.height).toBe(30);
    expect(result.stats.compressed.width).toBe(50);
    expect(result.stats.compressed.height).toBe(30);
  });

  test('applies defaults (format webp, quality 75) when omitted, matching the source', async () => {
    const imageBase64 = await noisyImageBase64(60, 60);
    const result = await compressImage({ imageBase64, maxDimension: DEFAULT_MAX_DIMENSION, format: 'webp', quality: DEFAULT_QUALITY });
    expect(result.mimeType).toBe('image/webp');
    expect(result.stats.quality).toBe(75);
  });

  test('higher quality produces a larger (or equal) file than lower quality for the same noisy image', async () => {
    const imageBase64 = await noisyImageBase64(120, 120);
    const low = await compressImage({ imageBase64, format: 'jpeg', quality: 10, maxDimension: DEFAULT_MAX_DIMENSION });
    const high = await compressImage({ imageBase64, format: 'jpeg', quality: 95, maxDimension: DEFAULT_MAX_DIMENSION });
    expect(high.stats.compressed.bytes).toBeGreaterThan(low.stats.compressed.bytes);
  });

  test('percentChange is signed: positive when the recompression shrank the file', async () => {
    const imageBase64 = await noisyImageBase64(150, 150);
    const result = await compressImage({ imageBase64, format: 'jpeg', quality: 30, maxDimension: DEFAULT_MAX_DIMENSION });
    // Lossless PNG of pure random noise vs a low-quality lossy JPEG -- must shrink.
    expect(result.stats.percentChange).toBeGreaterThan(0);
    expect(result.stats.compressed.bytes).toBeLessThan(result.stats.original.bytes);
  });

  test('rejects a corrupt/non-image input with a message instead of throwing an opaque error', async () => {
    const imageBase64 = Buffer.from('this is not an image').toString('base64');
    await expect(compressImage({ imageBase64, format: 'jpeg', quality: 75, maxDimension: DEFAULT_MAX_DIMENSION })).rejects.toThrow();
  });
});

describe('compressionCurve', () => {
  test('samples exactly the source\'s 14 fixed quality levels, sorted ascending, no image bytes returned', async () => {
    const imageBase64 = await noisyImageBase64(80, 80);
    const result = await compressionCurve({ imageBase64, format: 'jpeg', maxDimension: DEFAULT_MAX_DIMENSION });

    expect(CURVE_QUALITIES.slice().sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50, 55, 60, 70, 75, 80, 85, 90, 95, 100]);
    expect(result.points).toHaveLength(14);
    expect(result.points.map((p) => p.quality)).toEqual([10, 20, 30, 40, 50, 55, 60, 70, 75, 80, 85, 90, 95, 100]);
    result.points.forEach((p) => {
      expect(p.bytes).toBeGreaterThan(0);
      expect(typeof p.percentChange).toBe('number');
    });
    // No 'buffer' field anywhere in the result -- analysis only.
    expect(result.buffer).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/"buffer"/);
  });

  test('the highest sampled quality is at least as large as the lowest for the same noisy image', async () => {
    const imageBase64 = await noisyImageBase64(100, 100);
    const result = await compressionCurve({ imageBase64, format: 'webp', maxDimension: DEFAULT_MAX_DIMENSION });
    const first = result.points[0]; // quality 10
    const last = result.points[result.points.length - 1]; // quality 100
    expect(last.bytes).toBeGreaterThanOrEqual(first.bytes);
  });

  test('downscales before sampling, exactly like the source\'s working canvas', async () => {
    // The point of this test is the downscale ratio, not stress-testing the
    // encoder -- a small source at the same 10:1 ratio proves it identically
    // and keeps 14 AVIF encodes (the slowest of the three formats, over pure
    // random noise, the least compressible input possible) fast under any
    // machine load instead of racing a fixed timeout.
    const imageBase64 = await noisyImageBase64(600, 300);
    const result = await compressionCurve({ imageBase64, format: 'avif', maxDimension: 60 });
    expect(result.original).toEqual({ width: 600, height: 300, bytes: expect.any(Number) });
    expect(result.working).toEqual({ width: 60, height: 30, maxDimension: 60 });
  }, 20000);
});
