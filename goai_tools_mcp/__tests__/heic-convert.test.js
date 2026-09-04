'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

// Point the output store at a throwaway directory and drop the inline
// threshold to near-zero BEFORE requiring anything that loads outputStore, so
// the register()-level traversal test below actually exercises the on-disk
// (LINKED) write path — the sink the exploit hit — with a tiny fixture
// instead of needing a >4 MB decode.
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heic-store-test-'));
const ENV_BEFORE = {
  OUTPUT_STORE_DIR: process.env.OUTPUT_STORE_DIR,
  INLINE_OUTPUT_THRESHOLD_BYTES: process.env.INLINE_OUTPUT_THRESHOLD_BYTES,
};
process.env.OUTPUT_STORE_DIR = STORE_DIR;
process.env.INLINE_OUTPUT_THRESHOLD_BYTES = '10';

const heicModule = require('../controllers/tools/heic-convert');
const {
  convertHeicBatch,
  convertEntry,
  sniff,
  outputName,
  inputSchema,
} = heicModule;

afterAll(() => {
  fs.rmSync(STORE_DIR, { recursive: true, force: true });
  // These env vars persist across files in a Jest worker; restore them so a
  // later suite reloads outputStore with its own (default) values.
  for (const [k, v] of Object.entries(ENV_BEFORE)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// Drives the real registered tool the way the MCP server would: register()
// hands us its handler, which routes output through outputStore's sink.
function getToolHandler() {
  let handler;
  heicModule.register({ registerTool: (_name, _def, fn) => { handler = fn; } });
  return handler;
}

// No committed binary fixture: a real HEIC is generated once, in-process,
// via macOS's own `sips`, from a PNG built in-memory with sharp -- keeps the
// suite self-contained and gives every test a byte-real HEIC/HEIF container
// (not a hand-rolled stand-in) to run the actual libheif decoder against.
let heicBuffer;
let jpegBuffer;
let pngBuffer;

beforeAll(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heic-convert-test-'));
  const pngPath = path.join(tmpDir, 'source.png');
  const heicPath = path.join(tmpDir, 'source.heic');

  const png = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 60, b: 20 } },
  })
    .png()
    .toBuffer();
  fs.writeFileSync(pngPath, png);

  execFileSync('sips', ['-s', 'format', 'heic', pngPath, '--out', heicPath], { stdio: 'pipe' });
  heicBuffer = fs.readFileSync(heicPath);

  pngBuffer = png;
  jpegBuffer = await sharp({
    create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 10, b: 200 } },
  })
    .jpeg()
    .toBuffer();

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function b64(buf) {
  return buf.toString('base64');
}

describe('sniff', () => {
  test('identifies JPEG, PNG and ISO-base-media (ftyp) magic bytes, and falls back to other', () => {
    expect(sniff(jpegBuffer)).toBe('jpeg');
    expect(sniff(pngBuffer)).toBe('png');
    expect(sniff(heicBuffer)).toBe('iso'); // real HEIC container: ftyp box at offset 4
    expect(sniff(Buffer.from('not an image at all, just text'))).toBe('other');
  });
});

describe('outputName', () => {
  test('replaces the extension with .jpg or .png regardless of the original extension', () => {
    expect(outputName('IMG_0001.HEIC', 'image/jpeg')).toBe('IMG_0001.jpg');
    expect(outputName('photo.heif', 'image/png')).toBe('photo.png');
    expect(outputName('no-extension', 'image/jpeg')).toBe('no-extension.jpg');
  });
});

describe('convertEntry', () => {
  test('converts a real HEIC to JPEG: correct dimensions, shrunk-or-reasonable bytes, valid JPEG', async () => {
    const result = await convertEntry({ filename: 'IMG_1.heic', dataBase64: b64(heicBuffer) }, 'image/jpeg', 90);

    expect(result.status).toBe('converted');
    expect(result.outputFilename).toBe('IMG_1.jpg');
    expect(result.width).toBe(64);
    expect(result.height).toBe(48);
    expect(result.inputBytes).toBe(heicBuffer.length);
    expect(result.outputBytes).toBe(result.buffer.length);
    expect(result.buffer.length).toBeGreaterThan(0);

    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(48);

    // Pixel color round-trips close to the original fill (HEIC's own lossy
    // compression plus JPEG re-encoding means "close", not exact).
    const { data, info } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBeGreaterThanOrEqual(3);
    expect(data[0]).toBeGreaterThan(150); // red channel of the (200,60,20) fill
    expect(data[2]).toBeLessThan(100); // blue channel

    // Re-encoding must not carry EXIF/ICC forward (rule: no withMetadata()).
    expect(meta.exif).toBeUndefined();
  });

  test('converts a real HEIC to PNG losslessly (format/dimensions correct)', async () => {
    const result = await convertEntry({ filename: 'IMG_2.heic', dataBase64: b64(heicBuffer) }, 'image/png', 90);

    expect(result.status).toBe('converted');
    expect(result.outputFilename).toBe('IMG_2.png');
    expect(result.width).toBe(64);
    expect(result.height).toBe(48);

    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(48);
  });

  test('a higher JPEG quality produces larger (or equal) output bytes than a lower one', async () => {
    const low = await convertEntry({ filename: 'a.heic', dataBase64: b64(heicBuffer) }, 'image/jpeg', 50);
    const high = await convertEntry({ filename: 'a.heic', dataBase64: b64(heicBuffer) }, 'image/jpeg', 100);

    expect(high.outputBytes).toBeGreaterThanOrEqual(low.outputBytes);
  });

  test('an already-JPEG input is reported already_converted and passed through byte-for-byte unchanged', async () => {
    const result = await convertEntry({ filename: 'already.jpg', dataBase64: b64(jpegBuffer) }, 'image/jpeg', 90);

    expect(result.status).toBe('already_converted');
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.outputFilename).toBe('already.jpg'); // unchanged, not re-derived
    expect(result.width).toBeNull();
    expect(result.height).toBeNull();
    expect(result.inputBytes).toBe(jpegBuffer.length);
    expect(result.outputBytes).toBe(jpegBuffer.length);
    expect(Buffer.compare(result.buffer, jpegBuffer)).toBe(0); // identical bytes, not re-encoded
  });

  test('an already-PNG input is reported already_converted and passed through unchanged, even when a JPG output was requested', async () => {
    const result = await convertEntry({ filename: 'already.png', dataBase64: b64(pngBuffer) }, 'image/jpeg', 90);

    expect(result.status).toBe('already_converted');
    expect(result.mimeType).toBe('image/png');
    expect(Buffer.compare(result.buffer, pngBuffer)).toBe(0);
  });

  test('a corrupt / non-HEIC, non-image file is reported failed rather than throwing', async () => {
    const garbage = Buffer.from('this is not an image, heic or otherwise, just plain text bytes');
    const result = await convertEntry({ filename: 'garbage.heic', dataBase64: b64(garbage) }, 'image/jpeg', 90);

    expect(result.status).toBe('failed');
    expect(result.buffer).toBeNull();
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });

  test('a payload over byteLimits\' default cap is reported failed rather than throwing', async () => {
    // A base64 string whose *decoded* size estimate alone exceeds the
    // default 30MB cap -- byteLimits.decode() rejects it before ever
    // allocating the full buffer.
    const hugeBase64 = 'A'.repeat(41 * 1000 * 1000);
    const result = await convertEntry({ filename: 'huge.heic', dataBase64: hugeBase64 }, 'image/jpeg', 90);

    expect(result.status).toBe('failed');
    expect(result.buffer).toBeNull();
    expect(result.error).toMatch(/byte limit/);
  }, 15000);
});

describe('convertHeicBatch', () => {
  test('processes files in order and preserves that order in the results', async () => {
    const { results } = await convertHeicBatch({
      files: [
        { filename: 'first.heic', dataBase64: b64(heicBuffer) },
        { filename: 'second.jpg', dataBase64: b64(jpegBuffer) },
        { filename: 'third.heic', dataBase64: b64(Buffer.from('garbage')) },
      ],
      format: 'image/jpeg',
      quality: 90,
      bundleAsZip: false,
    });

    expect(results.map((r) => r.filename)).toEqual(['first.heic', 'second.jpg', 'third.heic']);
    expect(results[0].status).toBe('converted');
    expect(results[1].status).toBe('already_converted');
    expect(results[2].status).toBe('failed');
  });

  test('defaults format to image/jpeg and quality to 90 when omitted', async () => {
    const { results, format, quality } = await convertHeicBatch({
      files: [{ filename: 'only.heic', dataBase64: b64(heicBuffer) }],
    });

    expect(format).toBe('image/jpeg');
    expect(quality).toBe(90);
    expect(results[0].status).toBe('converted');
    expect(results[0].outputFilename).toBe('only.jpg');
  });
});

describe('inputSchema', () => {
  test('accepts 1 to 50 files and rejects 0 or 51', () => {
    const one = inputSchema.safeParse({ files: [{ filename: 'a.heic', dataBase64: 'QQ==' }] });
    expect(one.success).toBe(true);

    const zero = inputSchema.safeParse({ files: [] });
    expect(zero.success).toBe(false);

    const tooMany = inputSchema.safeParse({
      files: Array.from({ length: 51 }, (_, i) => ({ filename: `f${i}.heic`, dataBase64: 'QQ==' })),
    });
    expect(tooMany.success).toBe(false);
  });

  test('applies documented defaults for format, quality and bundleAsZip', () => {
    const parsed = inputSchema.parse({ files: [{ filename: 'a.heic', dataBase64: 'QQ==' }] });
    expect(parsed.format).toBe('image/jpeg');
    expect(parsed.quality).toBe(90);
    expect(parsed.bundleAsZip).toBe(false);
  });

  test('rejects a quality outside 50-100', () => {
    const tooLow = inputSchema.safeParse({ files: [{ filename: 'a.heic', dataBase64: 'QQ==' }], quality: 10 });
    expect(tooLow.success).toBe(false);
    const tooHigh = inputSchema.safeParse({ files: [{ filename: 'a.heic', dataBase64: 'QQ==' }], quality: 101 });
    expect(tooHigh.success).toBe(false);
  });
});

// Regression for the reported path-traversal: a caller-supplied filename is a
// label, never a path. The end-to-end proof is here (through register() and
// the real store), with the sink-level guarantees covered in
// outputStore.test.js.
describe('filename is a label, not a path (path-traversal regression)', () => {
  function listStoreFiles() {
    const found = [];
    for (const token of fs.readdirSync(STORE_DIR)) {
      const dir = path.join(STORE_DIR, token);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) found.push({ token, name, dir });
    }
    return found;
  }

  test('a traversal filename lands inside the token dir, flattened, with nothing written outside the store', async () => {
    const handler = getToolHandler();
    const res = await handler({
      files: [{ filename: '../../victim/OWNED.heic', dataBase64: heicBuffer.toString('base64') }],
      format: 'image/png',
    });

    // The caller still gets a real result (not a store failure).
    const link = res.content.find((c) => c.type === 'resource_link');
    expect(link).toBeDefined();

    // The bytes are in a token subdirectory under a flattened name...
    const payloads = listStoreFiles().filter((f) => f.name !== '.meta.json');
    expect(payloads).toHaveLength(1);
    expect(payloads[0].name).toBe('OWNED.png');

    // ...and nothing escaped one/two levels up out of the store.
    expect(fs.existsSync(path.join(STORE_DIR, 'victim'))).toBe(false);
    expect(fs.existsSync(path.join(STORE_DIR, '..', 'victim', 'OWNED.png'))).toBe(false);

    // The persisted meta carries the sanitised name.
    const meta = JSON.parse(fs.readFileSync(path.join(payloads[0].dir, '.meta.json'), 'utf8'));
    expect(meta.filename).toBe('OWNED.png');
  });

  test('a traversal filename in a bundled ZIP entry is sanitised (zip-slip)', async () => {
    const handler = getToolHandler();
    const b64 = heicBuffer.toString('base64');
    const res = await handler({
      files: [
        { filename: '../../../app/server.js.heic', dataBase64: b64 },
        { filename: 'normal.heic', dataBase64: b64 },
      ],
      format: 'image/png',
      bundleAsZip: true,
    });

    const link = res.content.find((c) => c.type === 'resource_link');
    expect(link).toBeDefined();

    const zipFile = listStoreFiles().find((f) => f.name.endsWith('.zip'));
    const zipBytes = fs.readFileSync(path.join(zipFile.dir, zipFile.name));
    // No entry path escapes the archive root.
    expect(zipBytes.toString('latin1').includes('../../../app')).toBe(false);
    expect(zipBytes.toString('latin1').includes('app/server.js.png')).toBe(true);
    expect(zipBytes.toString('latin1').includes('normal.png')).toBe(true);
  });
});
