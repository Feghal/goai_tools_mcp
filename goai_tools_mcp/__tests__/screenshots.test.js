'use strict';

// OUTPUT_STORE_DIR is read once at utils/outputStore.js load time, so it has
// to be pointed at a scratch directory BEFORE anything requires that module
// (the tool handler does, transitively). Otherwise the handler tests would
// write real files into the repo's .data/outputs.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'goai-screenshots-test-'));
process.env.OUTPUT_STORE_DIR = STORE_DIR;

// ---------------------------------------------------------------------------
// Instrumentation for the streaming invariant.
//
// The point of the render loop is that only ONE output canvas and only the
// bitmaps one slide actually needs are ever alive at the same time. RSS is a
// poor way to assert that (allocators keep freed pages, and the numbers move
// between platforms), so this counts the real events instead: a full-size
// createCanvas() is a canvas coming alive, `canvas.width = 1` is it being
// released, loadImage() is a bitmap coming alive, `image.src = <1x1 png>` is
// it being released.
//
// @napi-rs/canvas's exports and the width/src accessors are all writable and
// configurable, and screenshots.js destructures createCanvas/loadImage at
// require time — so the wrapping has to happen before it is required, which
// is why this block sits above the require below.
// ---------------------------------------------------------------------------
const canvasMod = require('@napi-rs/canvas');
const CanvasProto = Object.getPrototypeOf(canvasMod.createCanvas(1, 1));
const ImageProto = canvasMod.Image.prototype;

let track = null;
const liveCanvases = new WeakSet();
const liveImages = new WeakSet();

const realCreateCanvas = canvasMod.createCanvas;
canvasMod.createCanvas = function trackedCreateCanvas(w, h, ...rest) {
  const cv = realCreateCanvas(w, h, ...rest);
  // Ignore the module-level 10x10 metrics probe and padColour's 4x4 sampler;
  // only full-size output canvases are interesting.
  if (track && w > 64 && h > 64) {
    liveCanvases.add(cv);
    track.canvasesCreated++;
    track.canvasLive++;
    if (track.canvasLive > track.canvasPeak) track.canvasPeak = track.canvasLive;
  }
  return cv;
};

const widthDesc = Object.getOwnPropertyDescriptor(CanvasProto, 'width');
Object.defineProperty(CanvasProto, 'width', {
  configurable: true,
  enumerable: widthDesc.enumerable,
  get: widthDesc.get,
  set(v) {
    if (track && v <= 1 && liveCanvases.has(this)) {
      liveCanvases.delete(this);
      track.canvasLive--;
    }
    return widthDesc.set.call(this, v);
  },
});

const realLoadImage = canvasMod.loadImage;
canvasMod.loadImage = async function trackedLoadImage(src, opts) {
  const img = await realLoadImage(src, opts);
  if (track) {
    liveImages.add(img);
    track.imagesDecoded++;
    track.imageLive++;
    if (track.imageLive > track.imagePeak) track.imagePeak = track.imageLive;
  }
  return img;
};

const srcDesc = Object.getOwnPropertyDescriptor(ImageProto, 'src');
Object.defineProperty(ImageProto, 'src', {
  configurable: true,
  enumerable: srcDesc.enumerable,
  get: srcDesc.get,
  set(v) {
    if (track && liveImages.has(this)) {
      liveImages.delete(this);
      track.imageLive--;
    }
    return srcDesc.set.call(this, v);
  },
});

function startTracking() {
  track = { canvasesCreated: 0, canvasLive: 0, canvasPeak: 0, imagesDecoded: 0, imageLive: 0, imagePeak: 0 };
  return track;
}
function stopTracking() {
  const t = track;
  track = null;
  return t;
}

// ---------------------------------------------------------------------------

const { z } = require('zod');
const { createCanvas } = canvasMod;
const fonts = require('../utils/fonts');
const { zip } = require('../utils/zip');
const screenshots = require('../controllers/tools/screenshots');
const {
  renderScreenshots, LIMITS, SIZES, inputShape, plan, overlapsSlide,
  estimateOutputBytes, maxPagesFor, WORST_OUTPUT_BYTES_PER_MEGAPIXEL,
} = screenshots;

// The server registers the bundled fonts once at boot; without it every
// measureText() here would fall back to a default face and the fit maths
// would be measuring something other than what production draws.
fonts.registerAll();

const schema = z.object(inputShape);

afterAll(() => {
  fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

// ---- helpers --------------------------------------------------------------

// Sources are built in-memory with @napi-rs/canvas rather than checked in as
// fixture files, matching __tests__/app-icon.test.js. The canvas is released
// immediately so building a 5.7 MP fixture does not leave 23 MB alive for the
// rest of the file.
function makeSource(width, height, paint) {
  const c = createCanvas(width, height);
  const ctx = c.getContext('2d');
  if (paint) paint(ctx, width, height);
  else {
    const g = ctx.createLinearGradient(0, 0, width, height);
    g.addColorStop(0, '#22304a');
    g.addColorStop(1, '#8a3a5c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(${(i * 6) % 255},${(255 - i * 5) % 255},${(i * 11) % 255},0.55)`;
      ctx.fillRect((i * 97) % width, (i * 53) % height, width / 6, height / 20);
    }
  }
  const b64 = c.toBuffer('image/png').toString('base64');
  c.width = 1;
  c.height = 1;
  return b64;
}

function pngDims(buf) {
  // PNG IHDR: width/height are the big-endian uint32s at offsets 16 and 20.
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function isPng(buf) {
  return buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a;
}

// Independent confirmation, from outside this codebase's own encoder, that
// the bytes really are a PNG. Mirrors __tests__/app-icon.test.js.
function fileTypeOf(buf) {
  const tmp = path.join(STORE_DIR, `probe-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(tmp, buf);
  try {
    return execFileSync('file', ['-b', tmp]).toString('utf8').trim();
  } finally {
    fs.unlinkSync(tmp);
  }
}

// Store-only ZIP reader for exactly the format utils/zip.js writes, as in
// __tests__/resize.test.js.
function readZipEntries(buf) {
  const entries = [];
  let offset = 0;
  while (offset + 4 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    entries.push({
      name: buf.slice(nameStart, nameStart + nameLen).toString('utf8'),
      data: buf.slice(dataStart, dataStart + compSize),
    });
    offset = dataStart + compSize;
  }
  return entries;
}

// renderScreenshots() is the post-validation function: it expects the values
// zod has already defaulted, so tests that call it directly go through the
// real schema first rather than hand-rolling a half-populated object.
function parseInput(partial) {
  const parsed = schema.safeParse(partial);
  if (!parsed.success) throw new Error('fixture does not satisfy the schema: ' + parsed.error.message);
  return parsed.data;
}

function pageWith(b64, device) {
  return { imageBase64: b64, device: device || {} };
}

// The registered tool handler, captured through a stand-in server, so the
// handler's own naming/ZIP/emitBinaryOutput path is covered too.
function captureTool() {
  let captured = null;
  screenshots.register({
    registerTool(name, def, handler) {
      captured = { name, def, handler };
    },
  });
  return captured;
}

// ---------------------------------------------------------------------------

describe('render_app_store_screenshot — rendering', () => {
  const shot = makeSource(1290, 2796);

  test('one page, one size: a single real PNG at the exact canvas size', async () => {
    const input = parseInput({ pages: [pageWith(shot)], texts: [{ page: 0, text: 'Everything in one place' }] });
    const out = await renderScreenshots(input);

    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('6.9');
    expect(out[0].buffers).toHaveLength(1);
    const png = out[0].buffers[0];
    expect(isPng(png)).toBe(true);
    expect(pngDims(png)).toEqual({ width: 1320, height: 2868 });
    expect(fileTypeOf(png)).toMatch(/PNG image data, 1320 x 2868/);
  }, 30000);

  test('a null page and an image-less page both render, and neither draws a device', async () => {
    const input = parseInput({ pages: [null, pageWith(shot), {}], texts: [{ page: 0, text: 'Title card' }] });
    const out = await renderScreenshots(input);

    expect(out[0].buffers).toHaveLength(3);
    out[0].buffers.forEach((b) => expect(pngDims(b)).toEqual({ width: 1320, height: 2868 }));
    // Page 0 (null) and page 2 ({}) share a gradient and have no device, so
    // the only thing separating them is the text on page 0.
    const [p0, , p2] = out[0].buffers;
    expect(p0.equals(p2)).toBe(false);

    const noText = await renderScreenshots(parseInput({ pages: [null, pageWith(shot), {}] }));
    expect(noText[0].buffers[0].equals(noText[0].buffers[2])).toBe(true);
  }, 30000);

  test('a device pushed past its page edge is drawn on the neighbouring page too', async () => {
    const spill = await renderScreenshots(parseInput({ pages: [pageWith(shot, { dx: 0.9 }), {}] }));
    const flat = await renderScreenshots(parseInput({ pages: [pageWith(shot, { dx: 0 }), {}] }));
    // Page 2 is empty in the flat composition and carries the spilled-over
    // device in the other one.
    expect(spill[0].buffers[1].equals(flat[0].buffers[1])).toBe(false);
    expect(spill[0].buffers[1].length).toBeGreaterThan(flat[0].buffers[1].length);
  }, 30000);

  test('size:"all" exports every official App Store Connect size', async () => {
    const out = await renderScreenshots(parseInput({ pages: [pageWith(shot)], size: 'all' }));
    expect(out.map((o) => o.key)).toEqual(['6.9', '6.7', '6.5', '13ipad']);
    out.forEach((o) => {
      expect(o.buffers).toHaveLength(1);
      expect(pngDims(o.buffers[0])).toEqual({ width: SIZES[o.key][1], height: SIZES[o.key][2] });
    });
  }, 60000);

  test('the tool handler ZIPs a multi-page set with per-size directories', async () => {
    const tool = captureTool();
    const args = parseInput({ pages: [pageWith(shot), pageWith(shot)], texts: [{ page: 0, text: 'Two up' }] });
    const res = await tool.handler(args);

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.sizesRendered[0]).toMatchObject({ key: '6.9', width: 1320, height: 2868, pageCount: 2 });

    // Two pages means one ZIP, never two inline images. utils/outputStore.js
    // then decides embedded-vs-linked purely on size, so accept either and
    // pull the archive bytes back out of whichever it chose.
    expect(res.content.filter((c) => c.type === 'image')).toHaveLength(0);
    const link = res.content.find((c) => c.type === 'resource_link');
    const embedded = res.content.find((c) => c.type === 'resource');
    let zipBuf;
    if (link) {
      expect(link.name).toBe('app-store-screenshots.zip');
      expect(link.mimeType).toBe('application/zip');
      const token = link.uri.split('/files/')[1];
      zipBuf = fs.readFileSync(path.join(STORE_DIR, token, 'app-store-screenshots.zip'));
    } else {
      expect(embedded).toBeTruthy();
      expect(embedded.resource.mimeType).toBe('application/zip');
      zipBuf = Buffer.from(embedded.resource.blob, 'base64');
    }

    const entries = readZipEntries(zipBuf);
    expect(entries.map((e) => e.name)).toEqual([
      '6.9/screenshot-1320x2868-1.png',
      '6.9/screenshot-1320x2868-2.png',
    ]);
    entries.forEach((e) => {
      expect(isPng(e.data)).toBe(true);
      expect(pngDims(e.data)).toEqual({ width: 1320, height: 2868 });
    });
    // The archive really is byte-identical to zipping the same buffers.
    const direct = zip(entries.map((e) => ({ name: e.name, data: e.data })));
    expect(direct.equals(zipBuf)).toBe(true);
  }, 60000);
});

// ---------------------------------------------------------------------------

describe('render_app_store_screenshot — streaming, one canvas and one bitmap at a time', () => {
  const shot = makeSource(1290, 2796);

  test('an 8-page render never holds more than one canvas or one bitmap', async () => {
    const pages = [];
    const texts = [];
    for (let i = 0; i < 8; i++) {
      pages.push(pageWith(shot));
      texts.push({ page: i, text: 'Page ' + (i + 1), fitGroup: 'h' });
    }
    const input = parseInput({ pages, texts });

    const t = startTracking();
    try {
      const out = await renderScreenshots(input);
      expect(out[0].buffers).toHaveLength(8);
    } finally {
      stopTracking();
    }

    // Eight canvases are created — one per slide, so nothing is reused — but
    // each is released before the next exists. A reused canvas would keep a
    // reference to every image ever drawn on it; a retained one keeps its
    // whole 15 MB surface. Before this rewrite both counts were 8.
    expect(t.canvasesCreated).toBe(8);
    expect(t.canvasPeak).toBe(1);
    expect(t.canvasLive).toBe(0);

    // Nine decodes: one validation pass over the eight pages, then one per
    // slide as it is painted. Never two at once.
    expect(t.imagePeak).toBe(1);
    expect(t.imageLive).toBe(0);
    expect(t.imagesDecoded).toBe(16);
  }, 60000);

  test('size:"all" at its page cap still holds one canvas at a time', async () => {
    // maxPagesFor(), not MAX_RENDERS_PER_CALL: rendering every page four
    // times over is what binds at size:"all", and it binds on output bytes
    // before it binds on render count.
    const pageCount = maxPagesFor(Object.keys(SIZES));
    const pages = Array.from({ length: pageCount }, () => pageWith(shot));
    const input = parseInput({ pages, size: 'all' });

    const t = startTracking();
    try {
      const out = await renderScreenshots(input);
      expect(out.reduce((n, o) => n + o.buffers.length, 0)).toBe(pageCount * Object.keys(SIZES).length);
    } finally {
      stopTracking();
    }
    expect(t.canvasesCreated).toBe(pageCount * Object.keys(SIZES).length);
    expect(t.canvasPeak).toBe(1);
    expect(t.imagePeak).toBe(1);
    expect(t.canvasLive).toBe(0);
    expect(t.imageLive).toBe(0);
  }, 120000);

  test('a failing render releases its canvas and bitmaps too', async () => {
    // The running MAX_TOTAL_OUTPUT_BYTES check is the only failure that can
    // happen mid-render, and reaching it takes neutralising the pre-render
    // estimate first: the estimate is an upper bound on what a page count at
    // a size can produce, so anything it lets through, the running check also
    // lets through. Zeroing the table is how a test reaches the backstop the
    // estimate exists to keep unreachable.
    const originalBudget = LIMITS.MAX_TOTAL_OUTPUT_BYTES;
    const originalTable = WORST_OUTPUT_BYTES_PER_MEGAPIXEL.slice();
    WORST_OUTPUT_BYTES_PER_MEGAPIXEL.fill(0);
    LIMITS.MAX_TOTAL_OUTPUT_BYTES = 1;
    const t = startTracking();
    try {
      await expect(renderScreenshots(parseInput({ pages: [pageWith(shot), pageWith(shot)] })))
        .rejects.toThrow(/PNGs this call produces/);
    } finally {
      stopTracking();
      LIMITS.MAX_TOTAL_OUTPUT_BYTES = originalBudget;
      originalTable.forEach((v, i) => { WORST_OUTPUT_BYTES_PER_MEGAPIXEL[i] = v; });
    }
    // A canvas and a bitmap were live when it threw, and both were released.
    expect(t.canvasesCreated).toBe(1);
    expect(t.canvasLive).toBe(0);
    expect(t.imageLive).toBe(0);
  }, 30000);
});

// ---------------------------------------------------------------------------

describe('render_app_store_screenshot — schema bounds', () => {
  const tiny = makeSource(60, 130);

  test('more than MAX_PAGES pages is rejected by the schema, naming the limit', () => {
    const pages = Array.from({ length: LIMITS.MAX_PAGES + 1 }, () => ({}));
    const r = schema.safeParse({ pages });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error.issues)).toMatch(new RegExp(`at most ${LIMITS.MAX_PAGES} pages per call`));
    // …and exactly MAX_PAGES is fine.
    expect(schema.safeParse({ pages: pages.slice(1) }).success).toBe(true);
  });

  test('zero pages is rejected', () => {
    expect(schema.safeParse({ pages: [] }).success).toBe(false);
  });

  test('text layers are bounded in count and in length', () => {
    const texts = Array.from({ length: LIMITS.MAX_TEXTS + 1 }, (_, i) => ({ page: 0, text: 't' + i }));
    const tooMany = schema.safeParse({ pages: [{}], texts });
    expect(tooMany.success).toBe(false);
    expect(JSON.stringify(tooMany.error.issues)).toMatch(new RegExp(`at most ${LIMITS.MAX_TEXTS} text layers`));
    expect(schema.safeParse({ pages: [{}], texts: texts.slice(1) }).success).toBe(true);

    const tooLong = schema.safeParse({
      pages: [{}],
      texts: [{ page: 0, text: 'x'.repeat(LIMITS.MAX_TEXT_CHARS + 1) }],
    });
    expect(tooLong.success).toBe(false);
    expect(JSON.stringify(tooLong.error.issues)).toMatch(new RegExp(`at most ${LIMITS.MAX_TEXT_CHARS} characters`));
    expect(schema.safeParse({
      pages: [{}],
      texts: [{ page: 0, text: 'x'.repeat(LIMITS.MAX_TEXT_CHARS) }],
    }).success).toBe(true);
  });

  test('device geometry is bounded — scale, offset and rotation', () => {
    const bad = [
      { scale: LIMITS.MAX_DEVICE_SCALE + 0.01 },
      { scale: 0 },
      { dx: LIMITS.MAX_OFFSET + 0.01 },
      { dy: -LIMITS.MAX_OFFSET - 0.01 },
      { rotationDeg: LIMITS.MAX_ROTATION_DEG + 1 },
      { rotationDeg: -LIMITS.MAX_ROTATION_DEG - 1 },
    ];
    bad.forEach((device) => {
      expect(schema.safeParse({ pages: [{ imageBase64: tiny, device }] }).success).toBe(false);
    });
    const ok = { scale: LIMITS.MAX_DEVICE_SCALE, dx: LIMITS.MAX_OFFSET, dy: -LIMITS.MAX_OFFSET, rotationDeg: LIMITS.MAX_ROTATION_DEG };
    expect(schema.safeParse({ pages: [{ imageBase64: tiny, device: ok }] }).success).toBe(true);
  });

  test('the schema and the description tell a caller what the limits are', () => {
    const tool = captureTool();
    expect(tool.name).toBe('render_app_store_screenshot');
    const d = tool.def.description;
    expect(d).toMatch(new RegExp(`at most ${LIMITS.MAX_PAGES} pages`));
    expect(d).toMatch(new RegExp(`${LIMITS.MAX_RENDERS_PER_CALL} rendered PNGs per call`));
    expect(d).toMatch(new RegExp(`${LIMITS.MAX_IMAGE_PIXELS / 1e6} MP per screenshot`));
    expect(d).toMatch(new RegExp(`${LIMITS.MAX_TOTAL_IMAGE_BYTES / 1e6} MB of`));
    expect(d).toMatch(new RegExp(`${LIMITS.MAX_TEXTS} text layers of ${LIMITS.MAX_TEXT_CHARS} characters`));
    // size:"all" says what it costs and how to work around the cap.
    expect(tool.def.inputSchema.size.description).toMatch(/one call per size/);
  });
});

// ---------------------------------------------------------------------------

describe('render_app_store_screenshot — runtime bounds', () => {
  const shot = makeSource(600, 1300);

  test('pages x sizes over MAX_RENDERS_PER_CALL is refused before any rendering', async () => {
    const pages = Array.from({ length: 4 }, () => pageWith(shot));
    const t = startTracking();
    let message = '';
    try {
      await renderScreenshots(parseInput({ pages, size: 'all' }));
    } catch (e) {
      message = e.message;
    } finally {
      stopTracking();
    }
    expect(message).toMatch(/would render 16 PNGs \(4 pages x 4 sizes\)/);
    expect(message).toMatch(new RegExp(`over the ${LIMITS.MAX_RENDERS_PER_CALL} render limit`));
    expect(message).toMatch(/one call per size/);
    // The number the advice gives is the number the byte estimate enforces,
    // not MAX_RENDERS_PER_CALL / 4 — that arithmetic promised 3 pages at
    // size:"all" and the output budget only ever admitted 2.
    expect(message).toMatch(new RegExp(`at most ${maxPagesFor(Object.keys(SIZES))} pages per call`));
    // Nothing was drawn and nothing was decoded: the refusal is free.
    expect(t.canvasesCreated).toBe(0);
    expect(t.imagesDecoded).toBe(0);
  });

  test('MAX_PAGES pages at a single size is inside the render cap', () => {
    const pages = Array.from({ length: LIMITS.MAX_PAGES }, () => ({}));
    expect(LIMITS.MAX_PAGES).toBeLessThanOrEqual(LIMITS.MAX_RENDERS_PER_CALL);
    expect(schema.safeParse({ pages, size: '6.9' }).success).toBe(true);
  });

  // ---- MAX_PAGES and MAX_TOTAL_OUTPUT_BYTES have to be reachable together --
  // The two used to be mutually unsatisfiable: MAX_PAGES advertised 10 pages
  // and the 32 MB output budget could not hold 10 pages of any real
  // screenshot at any size, so the advertised capability was unusable AND the
  // caller paid a full 10-page render (15.4 s in the container) before being
  // told. These pin both halves of the fix — the budget now covers the
  // advertised page count, and what cannot fit is refused before any work.

  test('MAX_PAGES pages fits the output budget at every single size', () => {
    for (const key of Object.keys(SIZES)) {
      const worst = estimateOutputBytes(LIMITS.MAX_PAGES, [key]);
      expect(worst).toBeLessThanOrEqual(LIMITS.MAX_TOTAL_OUTPUT_BYTES);
      expect(maxPagesFor([key])).toBe(LIMITS.MAX_PAGES);
    }
  });

  test('maxPagesFor() is exactly where the pre-render check flips', () => {
    for (const keys of [['6.9'], ['13ipad'], Object.keys(SIZES)]) {
      const fits = maxPagesFor(keys);
      expect(fits).toBeGreaterThan(0);
      expect(estimateOutputBytes(fits, keys)).toBeLessThanOrEqual(LIMITS.MAX_TOTAL_OUTPUT_BYTES);
      if (fits < LIMITS.MAX_PAGES) {
        // One more page is over one of the two ceilings — bytes, or renders.
        const over = estimateOutputBytes(fits + 1, keys) > LIMITS.MAX_TOTAL_OUTPUT_BYTES
          || (fits + 1) * keys.length > LIMITS.MAX_RENDERS_PER_CALL;
        expect(over).toBe(true);
      }
    }
  });

  test('an over-budget page count is refused in milliseconds, before any render', async () => {
    // size:"all" past its page cap: legal by the schema and inside
    // MAX_RENDERS_PER_CALL, so only the output-byte estimate catches it.
    const over = maxPagesFor(Object.keys(SIZES)) + 1;
    expect(over * Object.keys(SIZES).length).toBeLessThanOrEqual(LIMITS.MAX_RENDERS_PER_CALL);
    const pages = Array.from({ length: over }, () => pageWith(shot));
    const input = parseInput({ pages, size: 'all' });

    const t = startTracking();
    const started = Date.now();
    let message = '';
    try {
      await renderScreenshots(input);
    } catch (e) {
      message = e.message;
    } finally {
      stopTracking();
    }
    const elapsed = Date.now() - started;

    expect(message).toMatch(new RegExp(`the PNGs ${over} pages at all 4 sizes can produce`));
    expect(message).toMatch(new RegExp(`limit ${LIMITS.MAX_TOTAL_OUTPUT_BYTES} bytes`));
    expect(message).toMatch(/refused before rendering rather than after/);
    expect(message).toMatch(new RegExp(`at most ${maxPagesFor(Object.keys(SIZES))} pages? per call`));
    // The whole point: nothing was decoded, nothing was drawn, and the answer
    // came back in milliseconds rather than after a full render.
    expect(t.canvasesCreated).toBe(0);
    expect(t.imagesDecoded).toBe(0);
    expect(elapsed).toBeLessThan(250);
  });

  test('MAX_PAGES real pages at one size render and stay inside the budget', async () => {
    // The exact call the old limits made impossible. Ten pages, each with a
    // real (not flat) source, at 6.9" — it must now complete, and the bytes
    // it really produces must be inside the budget the estimate promised.
    const pages = Array.from({ length: LIMITS.MAX_PAGES }, () => pageWith(shot));
    const out = await renderScreenshots(parseInput({ pages, size: '6.9' }));
    expect(out[0].buffers).toHaveLength(LIMITS.MAX_PAGES);
    const total = out[0].buffers.reduce((n, b) => n + b.length, 0);
    expect(total).toBeLessThanOrEqual(LIMITS.MAX_TOTAL_OUTPUT_BYTES);
    expect(total).toBeLessThanOrEqual(estimateOutputBytes(LIMITS.MAX_PAGES, ['6.9']));
  }, 180000);

  test('screenshot bytes over the aggregate limit are refused from the string length alone', async () => {
    // decodeBatch() sums the base64 lengths before allocating anything, so
    // this never turns into a Buffer — which is the point: an oversized batch
    // must not cost the memory it is being refused for.
    const oversized = 'A'.repeat(Math.ceil((LIMITS.MAX_TOTAL_IMAGE_BYTES * 4) / 3) + 1024);
    const t = startTracking();
    let message = '';
    try {
      await renderScreenshots(parseInput({ pages: [{ imageBase64: oversized }] }));
    } catch (e) {
      message = e.message;
    } finally {
      stopTracking();
    }
    expect(message).toMatch(/page screenshots in this call/);
    expect(message).toMatch(new RegExp(`= \\d+ bytes, limit ${LIMITS.MAX_TOTAL_IMAGE_BYTES} bytes`));
    expect(message).toMatch(/JPEG at quality 80/);
    expect(t.imagesDecoded).toBe(0);
  });

  test('the aggregate is a sum, not a per-page allowance', async () => {
    const half = 'A'.repeat(Math.ceil((LIMITS.MAX_TOTAL_IMAGE_BYTES * 4) / 3 / 2) + 512);
    await expect(renderScreenshots(parseInput({ pages: [{ imageBase64: half }, { imageBase64: half }] })))
      .rejects.toThrow(/page screenshots in this call/);
  });

  test('a screenshot over MAX_IMAGE_PIXELS is refused, naming the pixel limit', async () => {
    // Flat fill: a handful of KB on the wire, 6.6 MP once decoded. A byte cap
    // alone would never catch this.
    const bomb = makeSource(3000, 2200, (ctx, w, h) => { ctx.fillStyle = '#204060'; ctx.fillRect(0, 0, w, h); });
    expect(3000 * 2200).toBeGreaterThan(LIMITS.MAX_IMAGE_PIXELS);

    const t = startTracking();
    let message = '';
    try {
      await renderScreenshots(parseInput({ pages: [{ imageBase64: bomb }] }));
    } catch (e) {
      message = e.message;
    } finally {
      stopTracking();
    }
    expect(message).toMatch(/pages\[0\]\.imageBase64/);
    expect(message).toMatch(/3000x2200/);
    expect(message).toMatch(new RegExp(`over this server's ${LIMITS.MAX_IMAGE_PIXELS}-pixel decode limit`));
    // The bitmap that failed the check was released, and nothing was drawn.
    expect(t.imageLive).toBe(0);
    expect(t.canvasesCreated).toBe(0);
  }, 30000);

  test('undecodable bytes are reported as such, not drawn as an empty device', async () => {
    const junk = Buffer.from('this is definitely not an image').toString('base64');
    await expect(renderScreenshots(parseInput({ pages: [{ imageBase64: junk }] })))
      .rejects.toThrow(/pages\[0\]\.imageBase64 is not a decodable image/);
  });

  test('too many devices spilling onto one page is refused before that page is painted', async () => {
    // Five max-megapixel sources at the schema's largest scale, with the
    // outer pages' offsets aimed inward, all reach the middle page: 5 x
    // 5.68 MP x 4 = 114 MB of bitmaps that would have to be live together.
    const big = makeSource(2064, 2752, (ctx, w, h) => { ctx.fillStyle = '#123'; ctx.fillRect(0, 0, w, h); });
    const pages = [];
    for (let j = 0; j < 5; j++) {
      pages.push(pageWith(big, { dx: j < 2 ? 1 : j > 2 ? -1 : 0, scale: LIMITS.MAX_DEVICE_SCALE }));
    }
    const input = parseInput({ pages });

    // The composition really is legal by the schema; it is the per-slide
    // working set that is not.
    const geom = input.pages.map((p) => ({ device: { dx: p.device.dx, dy: p.device.dy, s: p.device.scale, rot: 0 } }));
    const p = plan(1320, 2868, geom, [], false, () => 50);
    const worst = Math.max(...Array.from({ length: p.n }, (_, i) => p.devices.filter((d) => overlapsSlide(d, i, 1320)).length));
    expect(worst).toBe(5);

    const t = startTracking();
    let message = '';
    try {
      await renderScreenshots(input);
    } catch (e) {
      message = e.message;
    } finally {
      stopTracking();
    }
    expect(message).toMatch(/devices spilling onto it/);
    expect(message).toMatch(new RegExp(`over the ${LIMITS.MAX_LIVE_IMAGE_BYTES / 1e6} MB limit`));
    expect(message).toMatch(/Reduce device\.scale or device\.dx/);
    // Validation decoded each source once, one at a time; no slide was painted.
    expect(t.canvasesCreated).toBe(0);
    expect(t.imagePeak).toBe(1);
    expect(t.imageLive).toBe(0);
  }, 60000);

  test('an over-limit call comes back as a tool error, not an exception', async () => {
    const tool = captureTool();
    const res = await tool.handler(parseInput({ pages: Array.from({ length: 4 }, () => ({})), size: 'all' }));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(new RegExp(`over the ${LIMITS.MAX_RENDERS_PER_CALL} render limit`));
  });
});
