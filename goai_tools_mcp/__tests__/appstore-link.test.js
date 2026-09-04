'use strict';

const fs = require('fs');
const path = require('path');
const { loadImage, createCanvas } = require('@napi-rs/canvas');

const toolPath = require.resolve('../controllers/tools/appstore-link');
const {
  buildAppStoreLink,
  buildLink,
  extractAppId,
  qrMatrix,
  renderQrPng,
  gmul,
  EXP,
  LOG,
  EC_M,
  ALIGN,
  MAX_QR_BYTES,
} = require(toolPath);

// ---------------------------------------------------------------------------
// Golden reference: the *actual* client-side <script> from
// nginx/sites/goai/tools/app-store-link.html, sliced out verbatim (from its
// `var EC_M` declaration to just before its DOM-touching code starts) and
// evaluated as-is. This is not a re-implementation of the encoder to compare
// against -- it is the live page's own code, run in Node, so any divergence
// between it and controllers/tools/appstore-link.js's qrMatrix would be a
// real behavioural difference from the source, not a porting artifact.
function loadSourceQrMatrix() {
  const htmlPath = path.join(
    __dirname,
    '..',
    '..',
    '..',
    'website_front',
    'nginx',
    'sites',
    'goai',
    'tools',
    'app-store-link.html'
  );
  const html = fs.readFileSync(htmlPath, 'utf8');
  const start = html.indexOf('var EC_M');
  const end = html.indexOf('var matrix = null, currentUrl');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('Could not locate the QR encoder block in app-store-link.html -- source may have moved.');
  }
  const snippet = html.slice(start, end);
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${snippet}\nreturn qrMatrix;`);
  return factory();
}

function matricesEqual(a, b) {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a.length; j++) {
      if (a[i][j] !== b[i][j]) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// A from-scratch QR decoder used only by these tests: recovers the original
// byte-mode payload from a finished module matrix by independently
// re-deriving which cells are structural (finder/timing/alignment/dark
// module/format/version areas), reading the format bits back out to learn
// the mask, un-masking, walking the same standardized zigzag placement order
// in reverse, de-interleaving the codeword blocks, and -- as a genuine
// mathematical check that the Reed-Solomon step is actually correct, not
// just "didn't throw" -- verifying every block's syndromes are all zero
// (i.e. the codeword the encoder wrote really does lie on the RS code, the
// same check a real decoder performs before ever trusting the data). This
// is the closest available substitute for a visual/photographic QR decode:
// no zbar/ImageMagick/pyzbar+libzbar was available on this machine to
// decode the rendered PNG as a barcode (see the test below that at least
// confirms the PNG's raster matches the matrix pixel-for-pixel).
function reservedMask(version, size) {
  const reserved = Array.from({ length: size }, () => new Array(size).fill(0));
  function markFinder(r, c) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        reserved[rr][cc] = 1;
      }
    }
  }
  markFinder(0, 0);
  markFinder(0, size - 7);
  markFinder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    reserved[6][i] = 1;
    reserved[i][6] = 1;
  }
  const centres = ALIGN[version];
  for (let i = 0; i < centres.length; i++) {
    for (let j = 0; j < centres.length; j++) {
      const ar = centres[i];
      const ac = centres[j];
      if ((ar === 6 && ac === 6) || (ar === 6 && ac === size - 7) || (ar === size - 7 && ac === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) reserved[ar + dr][ac + dc] = 1;
    }
  }
  reserved[size - 8][8] = 1;
  for (let i = 0; i <= 8; i++) {
    reserved[8][i] = 1;
    reserved[i][8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = 1;
    reserved[size - 1 - i][8] = 1;
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        reserved[i][size - 11 + j] = 1;
        reserved[size - 11 + j][i] = 1;
      }
    }
  }
  return reserved;
}

function decodeFormatBits(grid) {
  const copy1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  let raw = 0;
  for (let k = 0; k < 15; k++) {
    const [r, c] = copy1[k];
    raw = (raw << 1) | grid[r][c];
  }
  const unmasked = raw ^ 0x5412;
  const data = (unmasked >> 10) & 0x1f;
  return { mask: data & 0x7, ecLevel: (data >> 3) & 0x3 };
}

function maskFn(n, r, c) {
  switch (n) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

function extractZigzagBits(grid, reserved, size) {
  const bits = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let row = 0; row < size; row++) {
      const r2 = upward ? size - 1 - row : row;
      for (let s = 0; s < 2; s++) {
        const c2 = col - s;
        if (reserved[r2][c2]) continue;
        bits.push(grid[r2][c2]);
      }
    }
    upward = !upward;
  }
  return bits;
}

function rsSyndromesAllZero(codewordBytes, eccLen) {
  for (let j = 0; j < eccLen; j++) {
    let acc = 0;
    for (let i = 0; i < codewordBytes.length; i++) acc = gmul(acc, EXP[j]) ^ codewordBytes[i];
    if (acc !== 0) return false;
  }
  return true;
}

function decodeQr(matrix) {
  const size = matrix.length;
  const version = (size - 17) / 4;
  const { mask, ecLevel } = decodeFormatBits(matrix);
  if (ecLevel !== 0) throw new Error(`expected EC level M (00), read ${ecLevel}`);

  const reserved = reservedMask(version, size);
  const grid = matrix.map((row) => row.slice());
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && maskFn(mask, r, c)) grid[r][c] ^= 1;
    }
  }

  const bits = extractZigzagBits(grid, reserved, size);
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
    bytes.push(b);
  }

  const [eccLen, blocks, dataTotal] = EC_M[version];
  const expectedCodewords = dataTotal + eccLen * blocks;
  if (bytes.length !== expectedCodewords) {
    throw new Error(`extracted ${bytes.length} codewords, expected ${expectedCodewords}`);
  }

  const shortLen = Math.floor(dataTotal / blocks);
  const extra = dataTotal % blocks;
  const dataLens = [];
  for (let i = 0; i < blocks; i++) dataLens.push(shortLen + (i >= blocks - extra ? 1 : 0));
  const maxData = Math.max(...dataLens);

  const dataBlocks = dataLens.map(() => []);
  let p = 0;
  for (let col = 0; col < maxData; col++) {
    for (let b = 0; b < blocks; b++) if (col < dataLens[b]) dataBlocks[b].push(bytes[p++]);
  }
  const eccBlocks = dataLens.map(() => []);
  for (let col = 0; col < eccLen; col++) for (let b = 0; b < blocks; b++) eccBlocks[b].push(bytes[p++]);

  for (let b = 0; b < blocks; b++) {
    const codeword = dataBlocks[b].concat(eccBlocks[b]);
    if (!rsSyndromesAllZero(codeword, eccLen)) {
      throw new Error(`block ${b}'s Reed-Solomon syndromes are non-zero -- data/ECC disagree`);
    }
  }

  const dataStream = [].concat(...dataBlocks);
  let bitIdx = 0;
  function takeBits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byteIdx = Math.floor(bitIdx / 8);
      const bitOff = 7 - (bitIdx % 8);
      v = (v << 1) | ((dataStream[byteIdx] >> bitOff) & 1);
      bitIdx++;
    }
    return v;
  }
  const mode = takeBits(4);
  if (mode !== 4) throw new Error(`expected byte-mode indicator 0100, read ${mode.toString(2)}`);
  const countBits = version < 10 ? 8 : 16;
  const count = takeBits(countBits);
  const payload = [];
  for (let i = 0; i < count; i++) payload.push(takeBits(8));
  return { version, mask, text: Buffer.from(payload).toString('utf8') };
}

// ---------------------------------------------------------------------------

describe('extractAppId (source appId() port)', () => {
  test('pulls the id out of a full pasted App Store URL', () => {
    expect(extractAppId('https://apps.apple.com/us/app/neurobase/id6760698645')).toBe('6760698645');
  });
  test('is case-insensitive on the "id" marker', () => {
    expect(extractAppId('https://apps.apple.com/us/app/x/ID6478912345?pt=1')).toBe('6478912345');
  });
  test('accepts a bare numeric id, trimmed', () => {
    expect(extractAppId('  6478912345  ')).toBe('6478912345');
  });
  test('rejects a bare id shorter than 4 digits', () => {
    expect(extractAppId('123')).toBe('');
  });
  test('rejects a string that merely contains digits but is not id-prefixed or all-digit', () => {
    // No "id" marker, and not *only* digits once trimmed -- the source's
    // fallback regex is anchored (^\s*\d{4,}\s*$), it does not scan for a
    // digit run inside other text.
    expect(extractAppId('app6478912345')).toBe('');
    expect(extractAppId('6478912345 please')).toBe('');
  });
  test('empty / non-matching input yields empty string, not null/throw', () => {
    expect(extractAppId('')).toBe('');
    expect(extractAppId('not an id')).toBe('');
  });
});

describe('buildLink (source build() URL + params-table port)', () => {
  test('id-only, defaults: mt=8 appended, no pt/ct rows', () => {
    const r = buildLink({ appIdOrUrl: '6478912345', store: 'us', pt: '', ct: '', mt: true });
    expect(r.url).toBe('https://apps.apple.com/us/app/id6478912345?mt=8');
    expect(r.params).toEqual([
      { param: '/us/', value: 'us', meaning: 'Storefront the link opens in.' },
      { param: 'id', value: '6478912345', meaning: 'The app, by its numeric App Store ID.' },
      { param: 'mt', value: '8', meaning: 'Media type 8, meaning software.' },
    ]);
  });

  test('parameter order is always pt, then ct, then mt -- matching the source\'s qs.push sequence', () => {
    const r = buildLink({ appIdOrUrl: '6478912345', store: 'GB', pt: ' provider1 ', ct: ' summer_2026 ', mt: true });
    expect(r.store).toBe('gb');
    expect(r.url).toBe(
      'https://apps.apple.com/gb/app/id6478912345?pt=provider1&ct=summer_2026&mt=8'
    );
  });

  test('pt/ct are trimmed and encodeURIComponent-escaped; empty-after-trim omits the param entirely', () => {
    const r = buildLink({ appIdOrUrl: '6478912345', store: 'us', pt: '   ', ct: 'a b&c=d', mt: false });
    expect(r.url).toBe('https://apps.apple.com/us/app/id6478912345?ct=' + encodeURIComponent('a b&c=d'));
    expect(r.params.some((p) => p.param === 'pt')).toBe(false);
    expect(r.params.some((p) => p.param === 'mt')).toBe(false);
  });

  test('mt:false omits mt=8 and its row entirely', () => {
    const r = buildLink({ appIdOrUrl: '6478912345', store: 'us', mt: false });
    expect(r.url).toBe('https://apps.apple.com/us/app/id6478912345');
    expect(r.params.map((p) => p.param)).toEqual(['/us/', 'id']);
  });

  test('a pasted URL resolves to the same link a bare id would', () => {
    const fromUrl = buildLink({ appIdOrUrl: 'https://apps.apple.com/fr/app/x/id6749693340', store: 'fr', mt: true });
    const fromId = buildLink({ appIdOrUrl: '6749693340', store: 'fr', mt: true });
    expect(fromUrl.url).toBe(fromId.url);
  });

  test('throws a clean, actionable message when no id can be found', () => {
    expect(() => buildLink({ appIdOrUrl: 'not an id', store: 'us', mt: true })).toThrow(/enter an app id/i);
  });
});

describe('qrMatrix vs the live source script (byte-for-byte parity)', () => {
  const sourceQrMatrix = loadSourceQrMatrix();

  const cases = [
    'https://apps.apple.com/us/app/id6478912345',
    'https://apps.apple.com/us/app/id6478912345?pt=12345&ct=summer_campaign&mt=8',
    'https://apps.apple.com/jp/app/id1',
    'short',
    // right at, and one over, the version-10 byte ceiling
    'a'.repeat(MAX_QR_BYTES),
    'a'.repeat(MAX_QR_BYTES + 1),
    // a long ct pushing well into the middle versions
    'https://apps.apple.com/gb/app/id6749693340?ct=' +
      encodeURIComponent('a fairly long campaign token name used only to push this past a version boundary'),
    // multibyte UTF-8 payload -- byte length, not JS .length, drives version choice
    'https://apps.apple.com/jp/app/id1?ct=' + encodeURIComponent('日本語キャンペーン名'),
  ];

  test.each(cases)('matches the source\'s own qrMatrix() for %#: byte length %s', (text) => {
    const fromSource = sourceQrMatrix(text);
    const fromPort = qrMatrix(text);
    if (fromSource === null) {
      expect(fromPort).toBeNull();
      return;
    }
    expect(fromPort).not.toBeNull();
    expect(matricesEqual(fromSource, fromPort)).toBe(true);
  });

  test('at the version-10 byte ceiling: version 10, 57x57 modules; one byte over: null', () => {
    expect(qrMatrix('a'.repeat(MAX_QR_BYTES)).length).toBe(57);
    expect(qrMatrix('a'.repeat(MAX_QR_BYTES + 1))).toBeNull();
  });
});

describe('qrMatrix decodes back to the exact original text (independent structural decoder)', () => {
  const cases = [
    ['https://apps.apple.com/us/app/id6478912345', 3],
    ['https://apps.apple.com/us/app/id6478912345?pt=12345&ct=summer_campaign&mt=8', 5],
    ['https://apps.apple.com/jp/app/id1', 3],
    ['short', 1],
    ['a'.repeat(MAX_QR_BYTES), 10],
    ['https://apps.apple.com/de/app/id99999999999999999?pt=abc&ct=xyz', 5],
    ['https://apps.apple.com/jp/app/id1?ct=' + encodeURIComponent('日本語キャンペーン名'), null],
  ];

  test.each(cases)('round-trips %s', (text, expectedVersion) => {
    const matrix = qrMatrix(text);
    const decoded = decodeQr(matrix);
    expect(decoded.text).toBe(text);
    if (expectedVersion != null) expect(decoded.version).toBe(expectedVersion);
  });

  test('every mask index 0-7 is reachable and still decodes correctly (varies the input to force different winners)', () => {
    const seen = new Set();
    for (let i = 0; i < 60; i++) {
      const text = `https://apps.apple.com/us/app/id647891234${i}?ct=mask-probe-${i}-${'x'.repeat(i)}`;
      const matrix = qrMatrix(text);
      const decoded = decodeQr(matrix);
      expect(decoded.text).toBe(text);
      seen.add(decoded.mask);
    }
    // Not asserting all 8 appear (that's incidental to which inputs were
    // tried), just that mask selection is exercised and every result it
    // picks still decodes -- i.e. formatBits()/versionBits() round-trip
    // correctly for whichever mask actually wins.
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('renderQrPng produces a real PNG whose raster matches the matrix exactly', () => {
  test('every module\'s rendered pixel matches its matrix value, and the quiet zone is white', async () => {
    const text = 'https://apps.apple.com/us/app/id6478912345?pt=abc&ct=def';
    const matrix = qrMatrix(text);
    const { buffer, pixelSize, scale, quiet } = renderQrPng(matrix);

    // PNG signature + IHDR sanity, independent of @napi-rs/canvas's own decode.
    expect(buffer.slice(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(buffer.readUInt32BE(16)).toBe(pixelSize); // IHDR width
    expect(buffer.readUInt32BE(20)).toBe(pixelSize); // IHDR height

    // Actually decode the PNG bytes back to pixels (via @napi-rs/canvas's
    // own PNG decoder -- a different code path than the encoder that wrote
    // the file) and sample every module's centre pixel.
    const img = await loadImage(buffer);
    expect(img.width).toBe(pixelSize);
    expect(img.height).toBe(pixelSize);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, pixelSize, pixelSize);
    const pixelAt = (x, y) => {
      const i = (y * pixelSize + x) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };

    const size = matrix.length;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const x = Math.floor((c + quiet + 0.5) * scale);
        const y = Math.floor((r + quiet + 0.5) * scale);
        const expected = matrix[r][c] ? [0, 0, 0] : [255, 255, 255];
        expect(pixelAt(x, y)).toEqual(expected);
      }
    }

    // Quiet zone corners must be blank white.
    expect(pixelAt(1, 1)).toEqual([255, 255, 255]);
    expect(pixelAt(pixelSize - 2, pixelSize - 2)).toEqual([255, 255, 255]);
  });

  test('scale formula matches the source\'s canvas.width-based calc (264px baseline, min scale 2)', () => {
    // version 1 (21 modules) -> px width = 264 -> scale = floor(264/29) = 9
    const v1 = renderQrPng(qrMatrix('short'));
    expect(v1.scale).toBe(Math.max(2, Math.floor(264 / (21 + 8))));
    // version 10 (57 modules) -> scale = floor(264/65) = 4
    const v10 = renderQrPng(qrMatrix('a'.repeat(MAX_QR_BYTES)));
    expect(v10.scale).toBe(Math.max(2, Math.floor(264 / (57 + 8))));
  });
});

describe('buildAppStoreLink (full tool behaviour)', () => {
  test('includeQr false: returns url + params, no qr field, no png buffer', () => {
    const result = buildAppStoreLink({ appIdOrUrl: '6478912345', store: 'us', mt: true, includeQr: false });
    expect(result.url).toBe('https://apps.apple.com/us/app/id6478912345?mt=8');
    expect(result.appId).toBe('6478912345');
    expect(result.store).toBe('us');
    expect(result.params.length).toBeGreaterThan(0);
    expect(result.qr).toBeUndefined();
    expect(result._qrPngBuffer).toBeUndefined();
  });

  test('includeQr true: returns qr metadata and a real PNG buffer matching the encoded URL', () => {
    const result = buildAppStoreLink({ appIdOrUrl: '6478912345', store: 'us', pt: 'p1', ct: 'c1', mt: true, includeQr: true });
    expect(result.qr).toBeDefined();
    expect(result.qr.errorCorrection).toMatch(/^M /);
    expect(Buffer.isBuffer(result._qrPngBuffer)).toBe(true);
    expect(result._qrPngBuffer.slice(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

    const matrix = qrMatrix(result.url);
    expect(result.qr.moduleSize).toBe(matrix.length);
    expect(result.qr.version).toBe((matrix.length - 17) / 4);
  });

  test('includeQr true with a URL over the encoder ceiling fails cleanly, naming the byte counts, not a crash', () => {
    expect(() =>
      buildAppStoreLink({
        appIdOrUrl: '6478912345',
        store: 'us',
        ct: 'x'.repeat(MAX_QR_BYTES + 50),
        mt: false,
        includeQr: true,
      })
    ).toThrow(/longer than this encoder handles/i);
  });

  test('missing/invalid app id fails cleanly regardless of includeQr', () => {
    expect(() => buildAppStoreLink({ appIdOrUrl: 'nope', store: 'us', mt: true, includeQr: false })).toThrow();
  });
});

describe('register() wiring', () => {
  function getRegistered() {
    let captured = null;
    const stubServer = {
      registerTool(name, config, handler) {
        captured = { name, config, handler };
      },
    };
    require(toolPath).register(stubServer);
    return captured;
  }

  test('registers exactly one tool named build_app_store_link with the documented schema keys', () => {
    const { name, config } = getRegistered();
    expect(name).toBe('build_app_store_link');
    expect(require(toolPath).toolCount).toBe(1);
    expect(Object.keys(config.inputSchema).sort()).toEqual(
      ['appIdOrUrl', 'ct', 'includeQr', 'mt', 'pt', 'store'].sort()
    );
  });

  test('handler returns toolResult.fail (isError) for a bad app id, not a thrown exception', async () => {
    const { handler } = getRegistered();
    const res = await handler({ appIdOrUrl: 'nope', store: 'us', mt: true, includeQr: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/enter an app id/i);
  });

  test('handler returns image content alongside JSON text when includeQr is true', async () => {
    const { handler } = getRegistered();
    const res = await handler({ appIdOrUrl: '6478912345', store: 'us', mt: true, includeQr: true });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent.url).toContain('id6478912345');
    expect(res.structuredContent._qrPngBuffer).toBeUndefined();
    const hasImageOrResource = res.content.some((c) => c.type === 'image' || c.type === 'resource' || c.type === 'resource_link');
    expect(hasImageOrResource).toBe(true);
  });
});
