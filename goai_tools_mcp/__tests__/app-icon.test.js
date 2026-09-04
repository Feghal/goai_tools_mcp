'use strict';

const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createCanvas } = require('@napi-rs/canvas');
const { generateAppIconSet, SIZES, contentsJson } = require('../controllers/tools/app-icon');

// Minimal store-only zip reader for the exact format utils/zip.js writes
// (local file header, no data descriptor, method 0/store) -- used to verify
// the archive actually contains what the stats claim, not just that
// generateAppIconSet() didn't throw. Mirrors __tests__/resize.test.js.
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

function entryMap(buf) {
  const map = {};
  for (const e of readZipEntries(buf)) map[e.name] = e.data;
  return map;
}

// Builds an in-memory source PNG with @napi-rs/canvas itself rather than
// depending on an external fixture file, per the group's test guidance.
function makeSourceBase64(width, height, paint) {
  const c = createCanvas(width, height);
  const ctx = c.getContext('2d');
  paint(ctx, width, height);
  return c.toBuffer('image/png').toString('base64');
}

function pngDims(buf) {
  // PNG IHDR: width/height are the 4-byte big-endian ints at offsets 16/20.
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Independent confirmation (outside this codebase's own PNG encoder) that a
// produced file is actually a valid PNG of the claimed type, via the `file`
// utility -- present on this machine (ImageMagick's `identify` is not).
function fileTypeOf(buf) {
  const tmp = path.join(os.tmpdir(), `app-icon-test-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(tmp, buf);
  try {
    return execFileSync('file', ['-b', tmp]).toString('utf8').trim();
  } finally {
    fs.unlinkSync(tmp);
  }
}

const IOS_FILES_FOR = { none: 2, dark: 3, all: 4 }; // AppIcon(+Dark)(+Tinted) + Contents.json
const TOTAL_FILES_FOR = (mode) => IOS_FILES_FOR[mode] + SIZES.android.length + SIZES.plain.length;

describe('generateAppIconSet', () => {
  test('mode "none": only AppIcon.png + Contents.json on the iOS side, no Dark/Tinted', async () => {
    const imageBase64 = makeSourceBase64(1024, 1024, (ctx) => {
      ctx.fillStyle = '#204060';
      ctx.fillRect(0, 0, 1024, 1024);
    });

    const result = await generateAppIconSet({ imageBase64, variants: 'none', backgroundColor: '#ffffff' });

    expect(result.filename).toBe('app-icons.zip');
    expect(result.mimeType).toBe('application/zip');
    expect(result.stats.filesOut).toBe(TOTAL_FILES_FOR('none'));
    expect(result.stats.warnings).toEqual({ notSquare: null, small: null }); // exactly 1024x1024, square

    const entries = entryMap(result.buffer);
    const names = Object.keys(entries);
    expect(names).toContain('AppIcon.appiconset/AppIcon.png');
    expect(names).toContain('AppIcon.appiconset/Contents.json');
    expect(names).not.toContain('AppIcon.appiconset/AppIcon-Dark.png');
    expect(names).not.toContain('AppIcon.appiconset/AppIcon-Tinted.png');
    expect(names.length).toBe(TOTAL_FILES_FOR('none'));

    const cj = JSON.parse(entries['AppIcon.appiconset/Contents.json'].toString('utf8'));
    expect(cj).toEqual(JSON.parse(contentsJson('none')));
    expect(cj.images).toHaveLength(1);
    expect(cj.info).toEqual({ author: 'xcode', version: 1 });
  });

  test('mode "all": every android density and plain size lands at its exact pixel dimensions', async () => {
    const imageBase64 = makeSourceBase64(1024, 1024, (ctx) => {
      ctx.fillStyle = '#ff8800';
      ctx.fillRect(0, 0, 1024, 1024);
    });

    const result = await generateAppIconSet({ imageBase64, variants: 'all', backgroundColor: '#ffffff' });
    expect(result.stats.filesOut).toBe(TOTAL_FILES_FOR('all'));

    const entries = entryMap(result.buffer);
    expect(Object.keys(entries)).toHaveLength(TOTAL_FILES_FOR('all'));

    for (const a of SIZES.android) {
      const name = `android/${a.dir}/ic_launcher.png`;
      expect(entries[name]).toBeDefined();
      expect(pngDims(entries[name])).toEqual({ width: a.px, height: a.px });
    }
    for (const px of SIZES.plain) {
      const name = `sizes/icon-${px}.png`;
      expect(entries[name]).toBeDefined();
      expect(pngDims(entries[name])).toEqual({ width: px, height: px });
    }

    // Independently confirm at least one small and one large output decode
    // as real PNGs of the claimed size, via the system `file` tool.
    expect(fileTypeOf(entries['sizes/icon-16.png'])).toMatch(/PNG image data, 16 x 16/);
    expect(fileTypeOf(entries['AppIcon.appiconset/AppIcon.png'])).toMatch(/PNG image data, 1024 x 1024/);
  });

  test('Contents.json for "all" carries both appearance entries with the right keys', async () => {
    const imageBase64 = makeSourceBase64(64, 64, (ctx) => {
      ctx.fillStyle = '#123456';
      ctx.fillRect(0, 0, 64, 64);
    });
    const result = await generateAppIconSet({ imageBase64, variants: 'all', backgroundColor: '#ffffff' });
    const entries = entryMap(result.buffer);
    const cj = JSON.parse(entries['AppIcon.appiconset/Contents.json'].toString('utf8'));

    expect(cj.images).toEqual([
      { filename: 'AppIcon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' },
      {
        appearances: [{ appearance: 'luminosity', value: 'dark' }],
        filename: 'AppIcon-Dark.png',
        idiom: 'universal',
        platform: 'ios',
        size: '1024x1024',
      },
      {
        appearances: [{ appearance: 'luminosity', value: 'tinted' }],
        filename: 'AppIcon-Tinted.png',
        idiom: 'universal',
        platform: 'ios',
        size: '1024x1024',
      },
    ]);
  });

  test('non-square, non-1024 source: both warnings fire with the exact source dimensions', async () => {
    const imageBase64 = makeSourceBase64(300, 150, (ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 300, 150);
    });
    const result = await generateAppIconSet({ imageBase64, variants: 'none', backgroundColor: '#00ff00' });

    expect(result.stats.source).toEqual({ width: 300, height: 150 });
    expect(result.stats.warnings.notSquare).toBe(
      'Your image is 300×150, which is not square. It has been padded rather than stretched.'
    );
    expect(result.stats.warnings.small).toBe(
      'Your image is 300×150. Anything above 1024 is downscaled; anything below is upscaled and will look soft.'
    );
  });

  test('non-square source is letterboxed onto the background colour, not stretched', async () => {
    // 300 wide x 150 tall -> flatten() pads to a 300x300 square (side=max),
    // centering the content vertically -- so the very top rows of the
    // 1024x1024 AppIcon.png must be pure background colour, and the
    // vertical center must be the source's own fill colour.
    const imageBase64 = makeSourceBase64(300, 150, (ctx) => {
      ctx.fillStyle = '#3355ff';
      ctx.fillRect(0, 0, 300, 150);
    });
    const result = await generateAppIconSet({ imageBase64, variants: 'none', backgroundColor: '#ff00ff' });
    const entries = entryMap(result.buffer);
    const appIcon = entries['AppIcon.appiconset/AppIcon.png'];

    // Decode the produced PNG back with @napi-rs/canvas's own loadImage to
    // sample pixels, independent of the encode path under test.
    const { loadImage } = require('@napi-rs/canvas');
    const img = await loadImage(appIcon);
    const probe = createCanvas(img.width, img.height);
    const ctx = probe.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const topRow = ctx.getImageData(2, 2, 1, 1).data; // padding band, top-left-ish
    expect(Array.from(topRow)).toEqual([255, 0, 255, 255]); // magenta padding

    const center = ctx.getImageData(512, 512, 1, 1).data; // dead center = source content
    expect(Array.from(center)).toEqual([51, 85, 255, 255]); // #3355ff
  });

  test('tinted variant is a Rec.709 greyscale luminance map with alpha untouched', async () => {
    const imageBase64 = makeSourceBase64(64, 64, (ctx) => {
      ctx.fillStyle = 'rgb(200,50,20)';
      ctx.fillRect(0, 0, 64, 64);
    });
    const result = await generateAppIconSet({ imageBase64, variants: 'all', backgroundColor: '#ffffff' });
    const entries = entryMap(result.buffer);

    const { loadImage } = require('@napi-rs/canvas');
    const tintImg = await loadImage(entries['AppIcon.appiconset/AppIcon-Tinted.png']);
    const c = createCanvas(tintImg.width, tintImg.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(tintImg, 0, 0);
    const [r, g, b, a] = ctx.getImageData(512, 512, 1, 1).data;

    const expectedY = Math.round(0.2126 * 200 + 0.7152 * 50 + 0.0722 * 20);
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(Math.abs(r - expectedY)).toBeLessThanOrEqual(1); // ImageData rounding, see tinted()
    expect(a).toBe(255);
  });

  test('dark variant darkens toward black and is not just a copy of light', async () => {
    const imageBase64 = makeSourceBase64(64, 64, (ctx) => {
      ctx.fillStyle = 'rgb(200,150,100)';
      ctx.fillRect(0, 0, 64, 64);
    });
    const result = await generateAppIconSet({ imageBase64, variants: 'dark', backgroundColor: '#ffffff' });
    const entries = entryMap(result.buffer);

    const { loadImage } = require('@napi-rs/canvas');
    const darkImg = await loadImage(entries['AppIcon.appiconset/AppIcon-Dark.png']);
    const c = createCanvas(darkImg.width, darkImg.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(darkImg, 0, 0);
    const [r, g, b, a] = ctx.getImageData(512, 512, 1, 1).data;

    // out_rgb ~= round(rgb*0.82); allow +/-1 for compositing rounding (see
    // the comment on darkened() -- this is a real port of the source's
    // globalAlpha compositing, not a hand-rolled formula).
    expect(Math.abs(r - Math.round(200 * 0.82))).toBeLessThanOrEqual(1);
    expect(Math.abs(g - Math.round(150 * 0.82))).toBeLessThanOrEqual(1);
    expect(Math.abs(b - Math.round(100 * 0.82))).toBeLessThanOrEqual(1);
    expect(a).toBe(255);
  });

  test('transparency is reported and flattened onto the chosen background colour', async () => {
    const imageBase64 = makeSourceBase64(32, 32, (ctx) => {
      ctx.clearRect(0, 0, 32, 32); // fully transparent
      ctx.fillStyle = 'rgba(10,10,10,0.4)';
      ctx.fillRect(0, 0, 32, 32);
    });
    const result = await generateAppIconSet({ imageBase64, variants: 'none', backgroundColor: '#00ff00' });
    expect(result.stats.hadAlpha).toBe(true);

    const entries = entryMap(result.buffer);
    const { loadImage } = require('@napi-rs/canvas');
    const img = await loadImage(entries['AppIcon.appiconset/AppIcon.png']);
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const [, , , a] = ctx.getImageData(512, 512, 1, 1).data;
    expect(a).toBe(255); // flattened -- no alpha survives into the output
  });

  test('a fully opaque source reports no transparency', async () => {
    const imageBase64 = makeSourceBase64(32, 32, (ctx) => {
      ctx.fillStyle = '#112233';
      ctx.fillRect(0, 0, 32, 32);
    });
    const result = await generateAppIconSet({ imageBase64, variants: 'none', backgroundColor: '#ffffff' });
    expect(result.stats.hadAlpha).toBe(false);
  });

  test('an unreadable source image raises a clear, catchable error (not a crash)', async () => {
    const garbage = Buffer.from('this is not an image').toString('base64');
    await expect(generateAppIconSet({ imageBase64: garbage, variants: 'all', backgroundColor: '#ffffff' })).rejects.toThrow(
      /could not be read as an image/
    );
  });

  test('file manifest in the stats matches the actual zip contents 1:1', async () => {
    const imageBase64 = makeSourceBase64(1024, 1024, (ctx) => {
      ctx.fillStyle = '#abcdef';
      ctx.fillRect(0, 0, 1024, 1024);
    });
    const result = await generateAppIconSet({ imageBase64, variants: 'all', backgroundColor: '#ffffff' });
    const names = Object.keys(entryMap(result.buffer)).sort();
    const manifestNames = result.stats.files.map((f) => f.path).sort();
    expect(manifestNames).toEqual(names);
  });
});
