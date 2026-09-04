'use strict';

const sharp = require('sharp');
const gifEncoder = require('../utils/gifEncoder');

// gifEncoder.js is a verbatim port of nginx/sites/goai/assets/gif.js's
// window.GOAI_GIF -- these tests exercise the ported algorithm against real
// decoded GIF output (via sharp), not just "it ran without throwing".

function solid(w, h, r, g, b, a) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a == null ? 255 : a;
  }
  return d;
}

function hGradient(w, h) {
  // Left-to-right red-to-blue gradient, useful for exercising dithering.
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = x / (w - 1);
      const i = (y * w + x) * 4;
      d[i] = Math.round(255 * (1 - t));
      d[i + 1] = 0;
      d[i + 2] = Math.round(255 * t);
      d[i + 3] = 255;
    }
  }
  return d;
}

function bufferFromWriter(writer) {
  const bytes = writer.finish();
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe('palette', () => {
  test('two solid colors across two frames produce a 2-entry palette using both exact colors', () => {
    const w = 6, h = 4;
    const red = solid(w, h, 255, 0, 0);
    const blue = solid(w, h, 0, 0, 255);
    const pal = gifEncoder.palette([red, blue], 256);

    expect(pal.used).toBe(2);
    expect(pal.table.length).toBe(pal.size * 3);
    expect(pal.lookup.length).toBe(32768);

    const colors = [];
    for (let i = 0; i < pal.used; i++) colors.push([pal.table[i * 3], pal.table[i * 3 + 1], pal.table[i * 3 + 2]]);
    expect(colors).toContainEqual([255, 0, 0]);
    expect(colors).toContainEqual([0, 0, 255]);
  });

  test('a single solid-color frame collapses to a 1-entry palette (size rounds up to a power of two >= 2)', () => {
    const w = 4, h = 4;
    const pal = gifEncoder.palette([solid(w, h, 100, 150, 200)], 256);
    expect(pal.used).toBe(1);
    expect(pal.size).toBe(2);
    expect(pal.table.slice(0, 3)).toEqual(new Uint8Array([100, 150, 200]));
  });

  test('maxColors caps how many boxes are produced, never exceeding it', () => {
    const w = 32, h = 32;
    // A wide gradient carries far more than 4 distinct 5-bit-binned colors.
    const pal = gifEncoder.palette([hGradient(w, h)], 4);
    expect(pal.used).toBeLessThanOrEqual(4);
  });
});

describe('map', () => {
  test('without dither, every pixel of a solid-color frame maps to the same single palette index', () => {
    const w = 5, h = 5;
    const frame = solid(w, h, 10, 20, 30);
    const pal = gifEncoder.palette([frame], 256);
    const indices = gifEncoder.map(frame, w, h, pal, false);
    expect(indices.length).toBe(w * h);
    expect(new Set(indices).size).toBe(1);
    expect(indices[0]).toBe(0);
  });

  test('with dither on a two-color palette and a gradient frame, both palette indices appear (error diffusion actually ran)', () => {
    const w = 16, h = 4;
    const frame = hGradient(w, h);
    const pal = gifEncoder.palette([frame], 2);
    const indices = gifEncoder.map(frame, w, h, pal, true);
    expect(indices.length).toBe(w * h);
    const used = new Set(indices);
    expect(used.size).toBe(2);
  });

  test('dithered and non-dithered outputs differ for a gradient (dithering has a visible effect)', () => {
    const w = 20, h = 4;
    const frame = hGradient(w, h);
    const pal = gifEncoder.palette([frame], 4);
    const plain = gifEncoder.map(frame, w, h, pal, false);
    const dithered = gifEncoder.map(frame, w, h, pal, true);
    expect(Buffer.compare(Buffer.from(plain), Buffer.from(dithered))).not.toBe(0);
  });
});

describe('writer', () => {
  test('produces a valid GIF89a stream with correct signature, dimensions, frame count and per-frame delay (verified by re-decoding with sharp)', async () => {
    const w = 8, h = 6;
    const red = solid(w, h, 255, 0, 0);
    const green = solid(w, h, 0, 255, 0);
    const blue = solid(w, h, 0, 0, 255);
    const pal = gifEncoder.palette([red, green, blue], 256);
    const writer = gifEncoder.writer({ width: w, height: h, palette: pal, loop: true });
    writer.frame(gifEncoder.map(red, w, h, pal, false), 10);
    writer.frame(gifEncoder.map(green, w, h, pal, false), 25);
    writer.frame(gifEncoder.map(blue, w, h, pal, false), 40);
    const buf = bufferFromWriter(writer);

    expect(buf.slice(0, 6).toString('ascii')).toBe('GIF89a');
    // Logical screen descriptor: width/height as little-endian uint16 right
    // after the 6-byte signature.
    expect(buf.readUInt16LE(6)).toBe(w);
    expect(buf.readUInt16LE(8)).toBe(h);
    expect(buf[buf.length - 1]).toBe(0x3b); // trailer

    const meta = await sharp(buf, { animated: true }).metadata();
    expect(meta.width).toBe(w);
    expect(meta.pageHeight).toBe(h);
    expect(meta.pages).toBe(3);
    expect(meta.delay).toEqual([100, 250, 400]); // centiseconds -> ms
    expect(meta.loop).toBe(0); // NETSCAPE2.0 loop-forever extension present
  });

  test('loop:false omits the NETSCAPE loop extension, decoding as play-once', async () => {
    const w = 4, h = 4;
    const frame = solid(w, h, 200, 100, 50);
    const pal = gifEncoder.palette([frame], 64);
    const writer = gifEncoder.writer({ width: w, height: h, palette: pal, loop: false });
    writer.frame(gifEncoder.map(frame, w, h, pal, false), 5);
    const buf = bufferFromWriter(writer);

    expect(buf.toString('binary')).not.toContain('NETSCAPE2.0');
    const meta = await sharp(buf, { animated: true }).metadata();
    expect(meta.loop).toBe(1); // play once, not "loop forever"
  });

  test('pixel colors round-trip through the full palette+map+writer+decode pipeline', async () => {
    const w = 10, h = 10;
    const frame = solid(w, h, 30, 180, 90);
    const pal = gifEncoder.palette([frame], 256);
    const writer = gifEncoder.writer({ width: w, height: h, palette: pal, loop: true });
    writer.frame(gifEncoder.map(frame, w, h, pal, false), 10);
    const buf = bufferFromWriter(writer);

    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(w);
    expect(info.height).toBe(h);
    // 5-bit binning means each channel can be off by a few counts from the
    // source; the round-trip should still be close.
    expect(Math.abs(data[0] - 30)).toBeLessThan(10);
    expect(Math.abs(data[1] - 180)).toBeLessThan(10);
    expect(Math.abs(data[2] - 90)).toBeLessThan(10);
  });
});
