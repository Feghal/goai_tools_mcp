'use strict';

const sharp = require('sharp');
const { resizeImages } = require('../controllers/tools/resize');

// Minimal store-only zip reader for the exact format utils/zip.js writes
// (local file header, no data descriptor, method 0/store) -- used only to
// verify the archive resize.js produces actually contains what its stats
// claim, not just that resizeImages() didn't throw.
function readZipEntries(buf) {
  const entries = [];
  let offset = 0;
  while (offset + 4 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const name = buf.slice(nameStart, nameStart + nameLen).toString('utf8');
    const data = buf.slice(dataStart, dataStart + compSize);
    entries.push({ name, data });
    offset = dataStart + compSize;
  }
  return entries;
}

async function makeImage(width, height, color) {
  const buf = await sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
  return buf.toString('base64');
}

describe('resizeImages', () => {
  test('default preset (og) + default fit (contain): one 1200x630 PNG, padded', async () => {
    // A 400x400 square source into a 1200x630 box under 'contain' must be
    // letterboxed (scaled to fit height, padded left/right) -- verifies
    // real pixel dimensions and that the padding colour actually landed in
    // the untouched corner, not just that a file of the right name exists.
    const imageBase64 = await makeImage(400, 400, { r: 10, g: 20, b: 30 });

    const result = await resizeImages({
      images: [{ name: 'Photo One.png', imageBase64 }],
      preset: 'og',
      fit: 'contain',
      customWidth: 1200,
      customHeight: 630,
      paddingColor: '#00ff00',
    });

    expect(result.filename).toBe('resized.zip');
    expect(result.mimeType).toBe('application/zip');
    expect(result.stats.imagesIn).toBe(1);
    expect(result.stats.filesOut).toBe(1);
    expect(result.stats.sizes).toBe(1);
    expect(result.stats.outputs).toEqual([
      { source: 'Photo One.png', file: 'social/Photo-One-1200x630.png', width: 1200, height: 630, bytes: expect.any(Number) },
    ]);

    const entries = readZipEntries(result.buffer);
    expect(entries.map((e) => e.name)).toEqual(['social/Photo-One-1200x630.png']);

    const decoded = sharp(entries[0].data);
    const meta = await decoded.metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(630);

    // The contain fit scales the 400x400 source to fit the 630px height
    // (630x630), leaving padded columns on both sides -- sample a pixel
    // near the left edge, which must be pure padding, not source content.
    const { data, info } = await decoded.raw().toBuffer({ resolveWithObject: true });
    const px = (x, y) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    expect(px(2, 315)).toEqual([0, 255, 0]); // padding colour, top-left-ish column
  });

  test('custom preset + stretch fit: exact requested pixel dimensions, no padding colour applied', async () => {
    const imageBase64 = await makeImage(50, 200, { r: 200, g: 0, b: 0 });

    const result = await resizeImages({
      images: [{ name: 'a.jpg', imageBase64 }],
      preset: 'custom',
      fit: 'stretch',
      customWidth: 300,
      customHeight: 300,
      paddingColor: '#ffffff',
    });

    expect(result.stats.paddingColor).toBeNull(); // only reported for 'contain'
    const entries = readZipEntries(result.buffer);
    expect(entries.map((e) => e.name)).toEqual(['custom/a-300x300.png']);

    const meta = await sharp(entries[0].data).metadata();
    expect(meta.width).toBe(300);
    expect(meta.height).toBe(300);

    // Stretch fills the whole frame with source content -- no padding
    // colour should appear anywhere, including the corners.
    const { data, info } = await sharp(entries[0].data).raw().toBuffer({ resolveWithObject: true });
    const corner = [data[0], data[1], data[2]];
    expect(corner).not.toEqual([255, 255, 255]);
    void info;
  });

  test('androidIcon preset: 5 sizes, foldered by density name rather than suffixed by pixels', async () => {
    const imageBase64 = await makeImage(512, 512, { r: 1, g: 2, b: 3 });

    const result = await resizeImages({
      images: [{ name: 'icon.png', imageBase64 }],
      preset: 'androidIcon',
      fit: 'cover',
      customWidth: 1200,
      customHeight: 630,
      paddingColor: '#ffffff',
    });

    expect(result.stats.filesOut).toBe(5);
    expect(result.stats.sizes).toBe(5);
    const entries = readZipEntries(result.buffer);
    expect(entries.map((e) => e.name).sort()).toEqual(
      [
        'android/mipmap-mdpi/icon.png',
        'android/mipmap-hdpi/icon.png',
        'android/mipmap-xhdpi/icon.png',
        'android/mipmap-xxhdpi/icon.png',
        'android/mipmap-xxxhdpi/icon.png',
      ].sort()
    );

    const xxxhdpi = entries.find((e) => e.name === 'android/mipmap-xxxhdpi/icon.png');
    const meta = await sharp(xxxhdpi.data).metadata();
    expect(meta.width).toBe(192);
    expect(meta.height).toBe(192);
  });

  test('batch of multiple images x multiple sizes produces imagesIn * sizes files, sorted by name', async () => {
    const zBase64 = await makeImage(20, 20, { r: 5, g: 5, b: 5 });
    const aBase64 = await makeImage(20, 20, { r: 9, g: 9, b: 9 });

    const result = await resizeImages({
      images: [
        { name: 'z-shot.png', imageBase64: zBase64 },
        { name: 'a-shot.png', imageBase64: aBase64 },
      ],
      preset: 'favicon', // 6 sizes
      fit: 'contain',
      customWidth: 1200,
      customHeight: 630,
      paddingColor: '#ffffff',
    });

    expect(result.stats.imagesIn).toBe(2);
    expect(result.stats.sizes).toBe(6);
    expect(result.stats.filesOut).toBe(12);

    const entries = readZipEntries(result.buffer);
    expect(entries).toHaveLength(12);
    // Sorted-by-name: 'a-shot' entries precede 'z-shot' entries in the zip.
    expect(entries[0].name).toBe('favicon/a-shot-16x16.png');
    expect(entries.some((e) => e.name === 'favicon/z-shot-512x512.png')).toBe(true);

    // Every entry actually decodes as a PNG at its claimed size.
    for (const out of result.stats.outputs) {
      const entry = entries.find((e) => e.name === out.file);
      expect(entry).toBeDefined();
      const meta = await sharp(entry.data).metadata();
      expect(meta.format).toBe('png');
      expect(meta.width).toBe(out.width);
      expect(meta.height).toBe(out.height);
    }
  });

  test('a corrupt image fails the whole call with the offending filename named', async () => {
    await expect(
      resizeImages({
        images: [
          { name: 'good.png', imageBase64: await makeImage(10, 10, { r: 1, g: 1, b: 1 }) },
          { name: 'bad.png', imageBase64: Buffer.from('not an image').toString('base64') },
        ],
        preset: 'og',
        fit: 'contain',
        customWidth: 1200,
        customHeight: 630,
        paddingColor: '#ffffff',
      })
    ).rejects.toThrow(/bad\.png/);
  });
});
