'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createCanvas } = require('@napi-rs/canvas');

const mod = require('../controllers/tools/favicon');
const {
  generateFaviconSet,
  square,
  resize,
  onBackground,
  padded,
  ico,
  manifest,
  snippet,
  normalizeHex,
  register,
  toolCount,
} = mod;

// ---- fixtures ---------------------------------------------------------
// Built with @napi-rs/canvas itself, per the group's test-writing rule,
// rather than depending on an external image file.

// A solid, fully-opaque colour swatch -- used wherever the test just needs
// "a decodable image with a known colour", not transparency.
function solidCanvas(w, h, r, g, b, a = 255) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
  ctx.fillRect(0, 0, w, h);
  return c;
}

function pngBase64(canvas) {
  return canvas.toBuffer('image/png').toString('base64');
}

function px(canvas, x, y) {
  const ctx = canvas.getContext('2d');
  return Array.from(ctx.getImageData(x, y, 1, 1).data);
}

// Minimal ICO reader -- independent of ico()'s own implementation -- used to
// verify the produced container structurally rather than just re-deriving
// what ico() already computed.
function readIco(buf) {
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 16;
    entries.push({
      width: buf[p] === 0 ? 256 : buf[p],
      height: buf[p + 1] === 0 ? 256 : buf[p + 1],
      reservedByte: buf[p + 2],
      reservedByte2: buf[p + 3],
      planes: buf.readUInt16LE(p + 4),
      bpp: buf.readUInt16LE(p + 6),
      size: buf.readUInt32LE(p + 8),
      offset: buf.readUInt32LE(p + 12),
    });
  }
  return { reserved, type, count, entries };
}

describe('normalizeHex', () => {
  test('accepts 6-digit with #, lowercases', () => {
    expect(normalizeHex('#AABBCC', 'x')).toBe('#aabbcc');
  });
  test('accepts 6-digit without #', () => {
    expect(normalizeHex('112233', 'x')).toBe('#112233');
  });
  test('expands 3-digit shorthand', () => {
    expect(normalizeHex('#0af', 'x')).toBe('#00aaff');
    expect(normalizeHex('fff', 'x')).toBe('#ffffff');
  });
  test('rejects garbage with a message naming the field', () => {
    expect(() => normalizeHex('not-a-color', 'themeColor')).toThrow(/themeColor/);
  });
});

describe('square()', () => {
  test('centers a wide image on a transparent square canvas', () => {
    // 40x20 opaque red source -> 40x40 square: rows 0-9 and 30-39 must be
    // the untouched transparent canvas, not the source's colour.
    const src = solidCanvas(40, 20, 255, 0, 0, 255);
    const out = square(src);
    expect(out.width).toBe(40);
    expect(out.height).toBe(40);
    expect(px(out, 20, 2)).toEqual([0, 0, 0, 0]); // above the centred source: transparent
    expect(px(out, 20, 20)).toEqual([255, 0, 0, 255]); // inside the centred source
    expect(px(out, 20, 37)).toEqual([0, 0, 0, 0]); // below the centred source: transparent
  });

  test('centers a tall image the same way, on width this time', () => {
    const src = solidCanvas(20, 40, 0, 255, 0, 255);
    const out = square(src);
    expect(out.width).toBe(40);
    expect(out.height).toBe(40);
    expect(px(out, 2, 20)).toEqual([0, 0, 0, 0]);
    expect(px(out, 20, 20)).toEqual([0, 255, 0, 255]);
    expect(px(out, 37, 20)).toEqual([0, 0, 0, 0]);
  });

  test('an already-square image is unchanged in size and passes its colour through', () => {
    const src = solidCanvas(30, 30, 10, 20, 30, 255);
    const out = square(src);
    expect(out.width).toBe(30);
    expect(out.height).toBe(30);
    expect(px(out, 15, 15)).toEqual([10, 20, 30, 255]);
  });
});

describe('resize()', () => {
  test('produces exactly target x target regardless of the halving path', () => {
    const src = solidCanvas(1024, 1024, 5, 5, 5, 255);
    const out = resize(src, 16);
    expect(out.width).toBe(16);
    expect(out.height).toBe(16);
  });

  test('a solid-colour source resizes down to (approximately) the same solid colour', () => {
    const src = solidCanvas(512, 512, 200, 100, 50, 255);
    const out = resize(src, 48);
    const [r, g, b, a] = px(out, 24, 24);
    expect(a).toBe(255);
    // High-quality resampling of a flat colour should not drift noticeably.
    expect(Math.abs(r - 200)).toBeLessThanOrEqual(2);
    expect(Math.abs(g - 100)).toBeLessThanOrEqual(2);
    expect(Math.abs(b - 50)).toBeLessThanOrEqual(2);
  });

  test('upscaling (target above source width) skips the halving loop and still hits the target size', () => {
    const src = solidCanvas(10, 10, 1, 2, 3, 255);
    const out = resize(src, 96);
    expect(out.width).toBe(96);
    expect(out.height).toBe(96);
  });
});

describe('onBackground()', () => {
  test('flattens a transparent region to the background colour, opaque', () => {
    const src = createCanvas(20, 20); // fully transparent
    const ctx = src.getContext('2d');
    ctx.fillStyle = 'rgba(10,20,30,1)';
    ctx.fillRect(5, 5, 10, 10); // an opaque patch in the middle
    const out = onBackground(src, '#00ff00');
    expect(px(out, 1, 1)).toEqual([0, 255, 0, 255]); // was transparent -> now opaque bg
    expect(px(out, 10, 10)).toEqual([10, 20, 30, 255]); // opaque source pixel preserved
  });
});

describe('padded()', () => {
  test('draws the artwork into a centred 80%-width square, background elsewhere', () => {
    const size = 100;
    const src = solidCanvas(size, size, 255, 0, 0, 255);
    const out = padded(src, '#0000ff');
    // inner = round(100*0.8) = 80, off = round((100-80)/2) = 10.
    // A corner (outside [10,90)) must be pure background.
    expect(px(out, 2, 2)).toEqual([0, 0, 255, 255]);
    expect(px(out, 97, 97)).toEqual([0, 0, 255, 255]);
    // The centre must be the (resampled) source colour, not background.
    const [r, g, b, a] = px(out, 50, 50);
    expect(a).toBe(255);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(30);
    expect(b).toBeLessThan(30);
  });
});

describe('ico()', () => {
  test('header and per-entry directory fields match the ICONDIR/ICONDIRENTRY layout', () => {
    const png16 = createCanvas(16, 16).toBuffer('image/png');
    const png32 = createCanvas(32, 32).toBuffer('image/png');
    const png48 = createCanvas(48, 48).toBuffer('image/png');
    const buf = ico([
      { size: 16, data: png16 },
      { size: 32, data: png32 },
      { size: 48, data: png48 },
    ]);

    const parsed = readIco(buf);
    expect(parsed.reserved).toBe(0);
    expect(parsed.type).toBe(1);
    expect(parsed.count).toBe(3);
    expect(parsed.entries).toHaveLength(3);

    const expectedSizes = [16, 32, 48];
    const expectedData = [png16, png32, png48];
    let expectedOffset = 6 + 3 * 16;
    parsed.entries.forEach((e, i) => {
      expect(e.width).toBe(expectedSizes[i]);
      expect(e.height).toBe(expectedSizes[i]);
      expect(e.reservedByte).toBe(0);
      expect(e.reservedByte2).toBe(0);
      expect(e.planes).toBe(1);
      expect(e.bpp).toBe(32);
      expect(e.size).toBe(expectedData[i].length);
      expect(e.offset).toBe(expectedOffset);
      // The payload at that offset is the exact PNG bytes handed in.
      const payload = buf.slice(e.offset, e.offset + e.size);
      expect(Buffer.compare(payload, expectedData[i])).toBe(0);
      expectedOffset += e.size;
    });
    expect(buf.length).toBe(expectedOffset);
  });

  test('the produced bytes are independently recognized as a valid Windows icon', () => {
    const buf = ico([{ size: 32, data: createCanvas(32, 32).toBuffer('image/png') }]);
    const tmp = path.join(os.tmpdir(), `favicon-test-${process.pid}-${Date.now()}.ico`);
    fs.writeFileSync(tmp, buf);
    try {
      const out = execFileSync('file', ['--brief', tmp]).toString();
      expect(out.toLowerCase()).toMatch(/ico|icon/);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('a size of 256 or more is encoded as the ICO "0 means 256" convention', () => {
    const buf = ico([{ size: 256, data: createCanvas(4, 4).toBuffer('image/png') }]);
    expect(buf[6]).toBe(0);
    expect(buf[7]).toBe(0);
  });
});

describe('manifest()', () => {
  test('shape, purpose, and colour passthrough for maskable=true', () => {
    const text = manifest('My Site', 'Short', '#0a0a0c', '#ffffff', true);
    const obj = JSON.parse(text);
    expect(obj).toEqual({
      name: 'My Site',
      short_name: 'Short',
      icons: [
        { src: '/web-app-manifest-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
        { src: '/web-app-manifest-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
      theme_color: '#0a0a0c',
      background_color: '#ffffff',
      display: 'standalone',
    });
  });

  test('purpose is "any" for both icons when maskable=false', () => {
    const obj = JSON.parse(manifest('N', 'S', '#000000', '#ffffff', false));
    expect(obj.icons[0].purpose).toBe('any');
    expect(obj.icons[1].purpose).toBe('any');
  });

  test('short_name falls back to name, then to "My site"', () => {
    expect(JSON.parse(manifest('Full Name', '', '#000', '#fff', true)).short_name).toBe('Full Name');
    expect(JSON.parse(manifest('', '', '#000', '#fff', true)).name).toBe('My site');
    expect(JSON.parse(manifest('', '', '#000', '#fff', true)).short_name).toBe('My site');
  });
});

describe('snippet()', () => {
  test('exact 5-line block with the short name interpolated', () => {
    const text = snippet('My App', 'My App Full');
    expect(text).toBe(
      '<link rel="icon" href="/favicon.ico" sizes="32x32">\n' +
      '<link rel="icon" type="image/png" href="/favicon-96x96.png" sizes="96x96">\n' +
      '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">\n' +
      '<meta name="apple-mobile-web-app-title" content="My App">\n' +
      '<link rel="manifest" href="/site.webmanifest">'
    );
  });

  test('escapes only the double-quote character in the short name', () => {
    const text = snippet('Say "Hi" <there>', 'x');
    expect(text).toContain('content="Say &quot;Hi&quot; <there>">');
  });

  test('falls back from shortName to name when shortName is empty', () => {
    const text = snippet('', 'Fallback Name');
    expect(text).toContain('content="Fallback Name">');
  });
});

describe('generateFaviconSet()', () => {
  async function bigSource() {
    // 800x400: non-square (exercises square()'s centring in the full
        // pipeline) and >=512 on the long side (no size warning expected).
    const c = createCanvas(800, 400);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 800, 400); // transparent background
    ctx.fillStyle = '#3366ff';
    ctx.fillRect(200, 0, 400, 400); // an opaque centred column
    return c;
  }

  test('produces exactly the six named files with the right mime types, in order', async () => {
    const src = await bigSource();
    const result = await generateFaviconSet({
      imageBase64: pngBase64(src),
      siteName: 'My App',
      shortName: 'App',
      themeColor: '#0a0a0c',
      backgroundColor: '#ffffff',
      maskablePadding: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.files.map((f) => f.name)).toEqual([
      'favicon.ico',
      'favicon-96x96.png',
      'apple-touch-icon.png',
      'web-app-manifest-192x192.png',
      'web-app-manifest-512x512.png',
      'site.webmanifest',
    ]);
    expect(result.files.map((f) => f.mimeType)).toEqual([
      'image/x-icon',
      'image/png',
      'image/png',
      'image/png',
      'image/png',
      'application/manifest+json',
    ]);
    // 800x400 source -> squared side is max(800,400) = 800, well above 512.
    expect(result.squaredSide).toBe(800);
    expect(result.warning).toBeNull();
  });

  test('favicon.ico structurally holds 16/32/48 PNG entries that each decode back to the right size', async () => {
    const src = await bigSource();
    const result = await generateFaviconSet({ imageBase64: pngBase64(src) });
    const icoFile = result.files.find((f) => f.name === 'favicon.ico');
    const parsed = readIco(icoFile.data);
    expect(parsed.entries.map((e) => e.width)).toEqual([16, 32, 48]);

    const { loadImage } = require('@napi-rs/canvas');
    for (const e of parsed.entries) {
      const payload = icoFile.data.slice(e.offset, e.offset + e.size);
      expect(payload.slice(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); // PNG magic
      const decoded = await loadImage(payload);
      expect(decoded.width).toBe(e.width);
      expect(decoded.height).toBe(e.height);
    }

    // Independently confirmed by a real tool, not just by this file's own parser.
    const tmp = path.join(os.tmpdir(), `favicon-e2e-${process.pid}-${Date.now()}.ico`);
    fs.writeFileSync(tmp, icoFile.data);
    try {
      const out = execFileSync('file', ['--brief', tmp]).toString();
      expect(out.toLowerCase()).toMatch(/ico|icon/);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('apple-touch-icon is 180x180, fully opaque (flattened), and every other PNG decodes to its named size', async () => {
    const src = await bigSource();
    const result = await generateFaviconSet({ imageBase64: pngBase64(src), backgroundColor: '#00ff00' });
    const { loadImage } = require('@napi-rs/canvas');

    const wants = [
      ['favicon-96x96.png', 96],
      ['apple-touch-icon.png', 180],
      ['web-app-manifest-192x192.png', 192],
      ['web-app-manifest-512x512.png', 512],
    ];
    for (const [name, size] of wants) {
      const f = result.files.find((x) => x.name === name);
      const img = await loadImage(f.data);
      expect(img.width).toBe(size);
      expect(img.height).toBe(size);
    }

    const appleFile = result.files.find((f) => f.name === 'apple-touch-icon.png');
    const appleImg = await loadImage(appleFile.data);
    const canvas = createCanvas(180, 180);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(appleImg, 0, 0);
    // A corner of the original 800x400 source (centred on an 800x800 square)
    // was transparent -> after onBackground() it must be fully opaque green.
    const corner = px(canvas, 2, 2);
    expect(corner).toEqual([0, 255, 0, 255]);
  });

  test('maskablePadding=true pads the manifest icons and sets purpose "maskable"; false leaves them unpadded with purpose "any"', async () => {
    const src = await bigSource();
    const { loadImage } = require('@napi-rs/canvas');

    const padded_ = await generateFaviconSet({ imageBase64: pngBase64(src), maskablePadding: true });
    const unpadded = await generateFaviconSet({ imageBase64: pngBase64(src), maskablePadding: false });

    expect(JSON.parse(padded_.manifest).icons[0].purpose).toBe('maskable');
    expect(JSON.parse(unpadded.manifest).icons[0].purpose).toBe('any');

    // The source is a centred blue square well inside the frame, so at
    // (10,10) -- close to the corner -- the padded 512 icon must show flat
    // background colour, while the unpadded one is still just the
    // transparent margin around the (unpadded) artwork.
    const find512 = (r) => r.files.find((f) => f.name.includes('512'));
    const padded512 = find512(padded_);
    const plain512 = find512(unpadded);

    const pImg = await loadImage(padded512.data);
    const pCanvas = createCanvas(512, 512);
    pCanvas.getContext('2d').drawImage(pImg, 0, 0);
    // inner = round(512*0.8) = 410, off = round((512-410)/2) = 51 -> a pixel
    // at (10,10) is outside the inner box and must be the flat background.
    expect(px(pCanvas, 10, 10)).toEqual([255, 255, 255, 255]); // default bg #ffffff

    const uImg = await loadImage(plain512.data);
    const uCanvas = createCanvas(512, 512);
    uCanvas.getContext('2d').drawImage(uImg, 0, 0);
    // Unpadded: the same (10,10) corner is still outside the centred
    // 400-wide-of-800 opaque column once resized to 512, so it is
    // transparent, not filled -- proving no padding fill ran.
    expect(px(uCanvas, 10, 10)[3]).toBe(0);
  });

  test('warns when the squared source is under 512px on its long side', async () => {
    const small = createCanvas(64, 64);
    small.getContext('2d').fillRect(0, 0, 64, 64);
    const result = await generateFaviconSet({ imageBase64: pngBase64(small) });
    expect(result.squaredSide).toBe(64);
    expect(result.warning).toBe('That image is 64 pixels across. 512 or more gives a cleaner 512 icon.');
  });

  test('does not warn when the squared source is exactly 512', async () => {
    const c = createCanvas(512, 300);
    c.getContext('2d').fillRect(0, 0, 512, 300);
    const result = await generateFaviconSet({ imageBase64: pngBase64(c) });
    expect(result.squaredSide).toBe(512);
    expect(result.warning).toBeNull();
  });

  test('returns a soft error (not a throw) for undecodable image bytes', async () => {
    const result = await generateFaviconSet({ imageBase64: Buffer.from('not an image').toString('base64') });
    expect(result.error).toMatch(/could not be read as an image/);
    expect(result.files).toBeUndefined();
  });

  test('rejects a malformed colour before doing any drawing', async () => {
    const src = await bigSource();
    await expect(
      generateFaviconSet({ imageBase64: pngBase64(src), themeColor: 'not-a-color' })
    ).rejects.toThrow(/themeColor/);
  });

  test('siteName/shortName feed both the manifest and the snippet consistently', async () => {
    const src = await bigSource();
    const result = await generateFaviconSet({
      imageBase64: pngBase64(src),
      siteName: 'Full Name Co',
      shortName: 'FN Co',
    });
    expect(JSON.parse(result.manifest).name).toBe('Full Name Co');
    expect(JSON.parse(result.manifest).short_name).toBe('FN Co');
    expect(result.snippet).toContain('content="FN Co">');
  });
});

describe('register()', () => {
  test('registers exactly one tool named generate_favicon_set', () => {
    expect(toolCount).toBe(1);
    const registered = [];
    const fakeServer = { registerTool: (name, def, handler) => registered.push({ name, def, handler }) };
    register(fakeServer);
    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe('generate_favicon_set');
    expect(typeof registered[0].handler).toBe('function');
  });

  test('the handler returns content blocks for a real call, including a resource_link-free small ICO', async () => {
    const fakeServer = { registerTool: (name, def, handler) => { fakeServer.handler = handler; } };
    register(fakeServer);
    const src = createCanvas(600, 600);
    src.getContext('2d').fillRect(0, 0, 600, 600);
    const res = await fakeServer.handler({ imageBase64: pngBase64(src) });
    expect(res.isError).toBeUndefined();
    expect(Array.isArray(res.content)).toBe(true);
    expect(res.structuredContent.snippet).toContain('rel="manifest"');
    expect(res.structuredContent.warning).toBeNull();
  });

  test('the handler reports a tool failure (isError) for bad image bytes, never throws', async () => {
    const fakeServer = { registerTool: (name, def, handler) => { fakeServer.handler = handler; } };
    register(fakeServer);
    const res = await fakeServer.handler({ imageBase64: Buffer.from('garbage').toString('base64') });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/could not be read as an image/);
  });
});
