'use strict';

const { z } = require('zod');
const { createCanvas } = require('@napi-rs/canvas');
const toolResult = require('../../utils/toolResult');
const toolAnnotations = require('../../utils/toolAnnotations');
const outputStore = require('../../utils/outputStore');

// Ported from nginx/sites/goai/tools/app-store-link.html's inline <script>
// ("App Store link builder with QR code"): builds the campaign-attributed
// apps.apple.com URL exactly as the page's build() does, and -- when asked --
// renders the same hand-rolled byte-mode QR encoder (level M, versions 1-10)
// the page draws to its <canvas>, as a PNG. Read against the live source
// line-by-line; no behavioural disagreement was found between this port and
// that file. The one place with no direct equivalent to copy is the render
// step's canvas-size baseline -- see QR_CANVAS_BASE_PX below.

// ---- QR encoder: byte mode, error-correction level M, versions 1-10 ------
// [eccBytesPerBlock, blockCount, totalDataCodewords] per version -- copied
// verbatim from the source's EC_M table.
const EC_M = {
  1: [10, 1, 16], 2: [16, 1, 28], 3: [26, 1, 44], 4: [18, 2, 64],
  5: [24, 2, 86], 6: [16, 4, 108], 7: [18, 4, 124], 8: [22, 4, 154],
  9: [22, 5, 182], 10: [26, 5, 216],
};
// Alignment-pattern centre coordinates per version -- copied verbatim from
// the source's ALIGN table.
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

// GF(256) exp/log tables, primitive polynomial 0x11D -- identical
// construction to the source's IIFE.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function buildGaloisTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gmul(a, b) {
  return a && b ? EXP[LOG[a] + LOG[b]] : 0;
}

// Reed-Solomon generator polynomial for an n-byte ECC block: repeated
// multiplication by (x - a^i) for i = 0..n-1. Exact port of rsGenerator().
function rsGenerator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gmul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly.reverse(); // consumed high-order first
}

// Standard LFSR remainder against the generator poly. Exact port of
// rsEncode().
function rsEncode(data, n) {
  const gen = rsGenerator(n);
  const rem = new Array(n).fill(0);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let j = 0; j < n; j++) rem[j] ^= gmul(gen[j + 1], factor);
  }
  return rem;
}

// Largest UTF-8 byte length any of versions 1-10 at level M can hold: at
// version 10 (216 data codewords, 1728 bits, 16-bit count field),
// 4 + 16 + bytes*8 <= 1728 => bytes <= 213.5, i.e. 213 bytes. Used only to
// phrase the "too long" error without recomputing it per call.
const MAX_QR_BYTES = 213;

// Builds the final, masked module matrix for `text` (byte mode, level M), or
// null if its UTF-8 byte length does not fit any of versions 1-10. Exact
// port of the source's qrMatrix(), including its own inline comments where
// they explain a non-obvious step.
function qrMatrix(text) {
  const bytes = Buffer.from(text, 'utf8');
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const countBits = v < 10 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= EC_M[v][2] * 8) {
      version = v;
      break;
    }
  }
  if (!version) return null;
  const ecc = EC_M[version][0];
  const blocks = EC_M[version][1];
  const total = EC_M[version][2];

  // bitstream: mode 0100, character count, payload
  const bits = [];
  function push(value, n) {
    for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1);
  }
  push(4, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (let i = 0; i < bytes.length; i++) push(bytes[i], 8);
  for (let i = 0; i < 4 && bits.length < total * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
    words.push(b);
  }
  const pad = [0xec, 0x11];
  let p = 0;
  while (words.length < total) words.push(pad[p++ % 2]);

  // split into blocks; the last blocks are one byte longer when uneven
  const shortLen = Math.floor(total / blocks);
  const extra = total % blocks;
  const dataBlocks = [];
  const eccBlocks = [];
  let at = 0;
  for (let i = 0; i < blocks; i++) {
    const len = shortLen + (i >= blocks - extra ? 1 : 0);
    const block = words.slice(at, at + len);
    at += len;
    dataBlocks.push(block);
    eccBlocks.push(rsEncode(block, ecc));
  }
  const interleaved = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (let b2 = 0; b2 < blocks; b2++) {
      if (i < dataBlocks[b2].length) interleaved.push(dataBlocks[b2][i]);
    }
  }
  for (let i = 0; i < ecc; i++) {
    for (let b2 = 0; b2 < blocks; b2++) interleaved.push(eccBlocks[b2][i]);
  }

  const size = version * 4 + 17;
  const m = [];
  const reserved = [];
  for (let i = 0; i < size; i++) {
    m.push(new Array(size).fill(0));
    reserved.push(new Array(size).fill(0));
  }
  function place(r, c, value) {
    m[r][c] = value;
    reserved[r][c] = 1;
  }
  function finder(r, c) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const on =
          dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
          (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        place(rr, cc, on ? 1 : 0);
      }
    }
  }
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    place(6, i, i % 2 === 0 ? 1 : 0);
    place(i, 6, i % 2 === 0 ? 1 : 0);
  }
  const centres = ALIGN[version];
  for (let i = 0; i < centres.length; i++) {
    for (let j = 0; j < centres.length; j++) {
      const ar = centres[i];
      const ac = centres[j];
      if ((ar === 6 && ac === 6) || (ar === 6 && ac === size - 7) || (ar === size - 7 && ac === 6)) continue;
      for (let dr2 = -2; dr2 <= 2; dr2++) {
        for (let dc2 = -2; dc2 <= 2; dc2++) {
          const on2 = Math.max(Math.abs(dr2), Math.abs(dc2)) !== 1;
          place(ar + dr2, ac + dc2, on2 ? 1 : 0);
        }
      }
    }
  }
  place(size - 8, 8, 1); // dark module
  // reserve the format areas before laying data
  for (let i = 0; i <= 8; i++) {
    if (!reserved[8][i]) reserved[8][i] = 1;
    if (!reserved[i][8]) reserved[i][8] = 1;
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

  const dataBits = [];
  for (let i = 0; i < interleaved.length; i++) {
    for (let k = 7; k >= 0; k--) dataBits.push((interleaved[i] >> k) & 1);
  }
  let idx = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip the vertical timing column
    for (let row = 0; row < size; row++) {
      const r2 = upward ? size - 1 - row : row;
      for (let s = 0; s < 2; s++) {
        const c2 = col - s;
        if (reserved[r2][c2]) continue;
        m[r2][c2] = idx < dataBits.length ? dataBits[idx] : 0;
        idx++;
      }
    }
    upward = !upward;
  }

  function maskFn(n, r, c) {
    switch (n) {
      case 0:
        return (r + c) % 2 === 0;
      case 1:
        return r % 2 === 0;
      case 2:
        return c % 3 === 0;
      case 3:
        return (r + c) % 3 === 0;
      case 4:
        return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5:
        return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6:
        return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default:
        return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  }
  function formatBits(mask) {
    const data = (0x00 << 3) | mask; // 00 = level M
    let rem = data << 10;
    for (let i2 = 14; i2 >= 10; i2--) {
      if ((rem >> i2) & 1) rem ^= 0x537 << (i2 - 10);
    }
    return ((data << 10) | rem) ^ 0x5412;
  }
  function versionBits(v2) {
    let rem = v2 << 12;
    for (let i2 = 17; i2 >= 12; i2--) {
      if ((rem >> i2) & 1) rem ^= 0x1f25 << (i2 - 12);
    }
    return (v2 << 12) | rem;
  }
  function penalty(grid) {
    let score = 0;
    let dark = 0;
    for (let i2 = 0; i2 < size; i2++) {
      for (let dir = 0; dir < 2; dir++) {
        let run = 1;
        for (let j2 = 1; j2 < size; j2++) {
          const a = dir ? grid[j2][i2] : grid[i2][j2];
          const b = dir ? grid[j2 - 1][i2] : grid[i2][j2 - 1];
          if (a === b) {
            run++;
          } else {
            if (run >= 5) score += run - 2;
            run = 1;
          }
        }
        if (run >= 5) score += run - 2;
      }
    }
    for (let i2 = 0; i2 < size - 1; i2++) {
      for (let j2 = 0; j2 < size - 1; j2++) {
        const v3 = grid[i2][j2];
        if (v3 === grid[i2][j2 + 1] && v3 === grid[i2 + 1][j2] && v3 === grid[i2 + 1][j2 + 1]) score += 3;
      }
    }
    const patterns = [
      [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
      [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
    ];
    for (let i2 = 0; i2 < size; i2++) {
      for (let j2 = 0; j2 <= size - 11; j2++) {
        for (let pi = 0; pi < 2; pi++) {
          let okRow = true;
          let okCol = true;
          for (let k = 0; k < 11; k++) {
            if (grid[i2][j2 + k] !== patterns[pi][k]) okRow = false;
            if (grid[j2 + k][i2] !== patterns[pi][k]) okCol = false;
          }
          if (okRow) score += 40;
          if (okCol) score += 40;
        }
      }
    }
    for (let i2 = 0; i2 < size; i2++) for (let j2 = 0; j2 < size; j2++) if (grid[i2][j2]) dark++;
    score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return score;
  }

  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const grid = m.map((row) => row.slice());
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        if (!reserved[i][j] && maskFn(mask, i, j)) grid[i][j] ^= 1;
      }
    }
    const fmt = formatBits(mask);
    const copy1 = [
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
    ];
    const copy2 = [];
    for (let i = 0; i < 7; i++) copy2.push([size - 1 - i, 8]);
    for (let i = 0; i < 8; i++) copy2.push([8, size - 8 + i]);
    copy1.concat(copy2).forEach((cell, k) => {
      grid[cell[0]][cell[1]] = (fmt >> (14 - (k % 15))) & 1;
    });
    grid[size - 8][8] = 1;
    if (version >= 7) {
      const vb = versionBits(version);
      for (let i = 0; i < 18; i++) {
        const bit = (vb >> i) & 1;
        grid[Math.floor(i / 3)][size - 11 + (i % 3)] = bit;
        grid[size - 11 + (i % 3)][Math.floor(i / 3)] = bit;
      }
    }
    const score = penalty(grid);
    if (score < bestScore) {
      bestScore = score;
      best = grid;
    }
  }
  return best;
}

// The source scales its QR drawing against `canvas.width` as declared in the
// page's markup (<canvas id="qr" width="264" ...>) BEFORE that canvas is
// ever resized -- i.e. against the literal 264 the HTML ships, not a
// recomputed value. There is no <canvas> element here to read that
// attribute from, so 264 is reproduced as a named constant rather than left
// as a bare number; this is the one spot the port has no literal DOM
// equivalent to copy from, not a behavioural deviation (the arithmetic is
// identical either way).
const QR_CANVAS_BASE_PX = 264;

// Renders a module matrix (square array of 0/1) as a PNG: white background,
// filled black squares per dark module, `quiet` blank modules of margin on
// every side. Exact port of the source's post-qrMatrix() drawing loop.
function renderQrPng(matrix) {
  const size = matrix.length;
  const quiet = 4;
  const scale = Math.max(2, Math.floor(QR_CANVAS_BASE_PX / (size + quiet * 2)));
  const px = (size + quiet * 2) * scale;
  const canvas = createCanvas(px, px);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
  return { buffer: canvas.toBuffer('image/png'), pixelSize: px, scale, quiet };
}

// ---- URL assembly ----------------------------------------------------------

// Exact port of the source's appId(): /id(\d{4,})/i anywhere in the string
// wins first (pulling an id out of a pasted apps.apple.com URL); failing
// that, the WHOLE trimmed input must itself be 4+ digits (a bare id typed
// in directly), not merely contain a 4+ digit run somewhere in the middle.
// An App Store track id is 9-10 digits. The source's /(\d{4,})/ patterns have
// no upper bound, so a multi-megabyte run of digits was accepted as an id --
// verified -- and then interpolated into the returned URL and (when
// includeQr is set) fed to the QR encoder. Rejected rather than truncated: a
// truncated id would silently build a link to a DIFFERENT app.
const MAX_APP_ID_DIGITS = 24;

// Campaign/provider tokens. See the schema note on pt/ct for why this is
// bounded; real App Store Connect tokens are short identifiers.
const MAX_TOKEN_CHARS = 256;

function extractAppId(raw) {
  const s = String(raw == null ? '' : raw);
  const m = s.match(/id(\d{4,})/i) || s.match(/^\s*(\d{4,})\s*$/);
  if (!m) return '';
  if (m[1].length > MAX_APP_ID_DIGITS) return '';
  return m[1];
}

// Mirrors the source's per-parameter description strings (S.pCountry etc in
// its link-strings JSON block).
const PARAM_MEANING = {
  country: 'Storefront the link opens in.',
  id: 'The app, by its numeric App Store ID.',
  pt: 'Provider token: identifies your account to App Analytics.',
  ct: 'Campaign token: the name you will read in the report.',
  mt: 'Media type 8, meaning software.',
};

// Exact port of the source's build(): assembles the URL (storefront, app id,
// then pt/ct/mt in that order, each omitted when not supplied) and the same
// params-table rows the page renders underneath it.
function buildLink({ appIdOrUrl, store, pt, ct, mt }) {
  const id = extractAppId(appIdOrUrl);
  if (!id) {
    throw new Error(
      'Enter an app ID, or paste an App Store URL (e.g. "https://apps.apple.com/us/app/x/id6478912345" or just "6478912345").'
    );
  }
  const storeCode = String(store).trim().toLowerCase();
  const ptTrimmed = pt != null ? String(pt).trim() : '';
  const ctTrimmed = ct != null ? String(ct).trim() : '';
  const includeMt = mt !== false;

  let url = `https://apps.apple.com/${storeCode}/app/id${id}`;
  const qs = [];
  if (ptTrimmed) qs.push('pt=' + encodeURIComponent(ptTrimmed));
  if (ctTrimmed) qs.push('ct=' + encodeURIComponent(ctTrimmed));
  if (includeMt) qs.push('mt=8');
  if (qs.length) url += '?' + qs.join('&');

  const params = [
    { param: `/${storeCode}/`, value: storeCode, meaning: PARAM_MEANING.country },
    { param: 'id', value: id, meaning: PARAM_MEANING.id },
  ];
  if (ptTrimmed) params.push({ param: 'pt', value: ptTrimmed, meaning: PARAM_MEANING.pt });
  if (ctTrimmed) params.push({ param: 'ct', value: ctTrimmed, meaning: PARAM_MEANING.ct });
  if (includeMt) params.push({ param: 'mt', value: '8', meaning: PARAM_MEANING.mt });

  return { id, store: storeCode, url, params };
}

// Full tool behaviour: always builds the URL + params table; additionally
// renders the QR PNG when includeQr is true. A URL too long for the byte-
// mode/level-M encoder across versions 1-10 (>213 UTF-8 bytes) throws a
// plain Error naming the byte counts -- caught by register() below and
// turned into a clean toolResult.fail() rather than a crash, matching the
// source's own S.tooLong status rather than letting qrMatrix's null ripple
// up as an exception.
function buildAppStoreLink(input) {
  const built = buildLink(input);
  const result = {
    url: built.url,
    appId: built.id,
    store: built.store,
    params: built.params,
  };

  if (!input.includeQr) {
    return result;
  }

  const matrix = qrMatrix(built.url);
  const byteLength = Buffer.byteLength(built.url, 'utf8');
  if (!matrix) {
    throw new Error(
      `That URL is ${byteLength} bytes, longer than this encoder handles (byte-mode, error-correction level M, versions 1-10 top out at ${MAX_QR_BYTES} bytes). Shorten the campaign token (ct) or provider token (pt), or call again with includeQr:false to still get the URL.`
    );
  }
  const size = matrix.length;
  const version = (size - 17) / 4;
  const { buffer, pixelSize, scale } = renderQrPng(matrix);
  result.qr = {
    version,
    moduleSize: size,
    errorCorrection: 'M (about 15% recoverable)',
    urlByteLength: byteLength,
    pixelSize,
    scale,
  };
  result._qrPngBuffer = buffer;
  return result;
}

// The shape of the JSON in structuredContent. This tool also returns the
// generated file as a separate content block (inline image, embedded
// resource, or a resource_link to GET /files/:token, whichever
// utils/outputStore.js picks); the schema below covers the metadata half
// only, which is what the handler has always put in structuredContent.
const appStoreLinkOutputSchema = {
  url: z.string().describe('The assembled apps.apple.com URL -- the answer most callers want.'),
  appId: z.string().describe('The numeric app ID, whether given directly or extracted from a pasted URL.'),
  store: z.string().describe('The two-letter storefront code the URL targets.'),
  params: z
    .array(
      z.object({
        param: z.string().describe('Query parameter name.'),
        value: z.string().describe('Its value in the assembled URL.'),
        meaning: z.string().describe('What that parameter does, since App Store Connect campaign parameters are not self-explanatory.'),
      })
    )
    .describe('Every query parameter in the URL, explained.'),
  qr: z
    .object({
      version: z.number().int().describe('QR symbol version (1-10) the encoder settled on.'),
      moduleSize: z.number().int().describe('Symbol size in modules per side.'),
      errorCorrection: z.string().describe('Error-correction level used.'),
      urlByteLength: z.number().int().describe('UTF-8 byte length of the encoded URL; the version 10 ceiling is 213.'),
      pixelSize: z.number().int().describe('Rendered PNG size in px.'),
      scale: z.number().int().describe('Pixels per module.'),
    })
    .optional()
    .describe('Details of the rendered QR code. Present only when includeQr was true -- the PNG itself comes back as a separate content block.'),
};

function register(server) {
  server.registerTool(
    'build_app_store_link',
    {
      title: 'App Store campaign link builder + QR code',
      description:
        'Builds a correct apps.apple.com URL for an app ID or a pasted App Store URL, in a chosen ' +
        'two-letter storefront, with optional App Store Connect campaign attribution parameters ' +
        '(pt, ct, and mt=8). Always returns the assembled URL and a params table describing what ' +
        'each part does. When includeQr is true, also renders the URL as a QR code PNG using the ' +
        'same hand-rolled, dependency-free Reed-Solomon byte-mode encoder (error-correction level ' +
        'M, versions 1-10) the source browser page draws to its own <canvas> -- not a generic QR ' +
        'library, so the module layout, masking, and pixel output match that page exactly. The ' +
        'encoder tops out at 213 UTF-8 bytes for the assembled URL (version 10 ceiling); a longer ' +
        'URL fails cleanly naming the byte counts rather than returning a broken code -- shorten ' +
        'pt/ct or call again with includeQr:false to still get the plain URL. The storefront code ' +
        'is not checked against the list of real App Store storefronts -- a well-formed but unused ' +
        'code just will not have the app listed on it.',
      annotations: toolAnnotations.PURE,
      outputSchema: appStoreLinkOutputSchema,
      inputSchema: {
        appIdOrUrl: z
          .string()
          .trim()
          .min(1, 'appIdOrUrl is required')
          // Comfortably longer than any real apps.apple.com URL.
          .max(2048)
          .describe(
            `Numeric App Store app ID (e.g. "6478912345"), or a full pasted App Store URL containing one (e.g. "https://apps.apple.com/us/app/x/id6478912345"). The id is extracted from anywhere in a URL; a bare value must be 4+ digits with nothing else, and at most ${MAX_APP_ID_DIGITS} digits either way.`
          ),
        store: z
          .string()
          .trim()
          .regex(/^[A-Za-z]{2}$/, 'store must be a 2-letter storefront code, e.g. "us"')
          .transform((s) => s.toLowerCase())
          .describe('2-letter App Store storefront code (e.g. "us", "gb", "jp"). Decides which country\'s listing, price, and availability the link opens.'),
        // pt/ct are percent-encoded into the returned URL. Unbounded, they
        // were a straight amplifier: a 2 MB ct becomes a ~6 MB URL after
        // encodeURIComponent (every byte can expand to "%XX"), returned in
        // the JSON result AND echoed again in the params table. The QR
        // encoder's own 213-byte ceiling only applies when includeQr is set.
        // 256 is far beyond any real App Store Connect campaign token.
        pt: z
          .string()
          .max(MAX_TOKEN_CHARS)
          .optional()
          .describe(`Provider token (pt) for App Store Connect campaign attribution, up to ${MAX_TOKEN_CHARS} characters. Trimmed; omitted from the URL entirely if empty after trimming.`),
        ct: z
          .string()
          .max(MAX_TOKEN_CHARS)
          .optional()
          .describe(`Campaign token (ct) for App Store Connect campaign attribution, up to ${MAX_TOKEN_CHARS} characters. Trimmed; omitted from the URL entirely if empty after trimming.`),
        mt: z
          .boolean()
          .default(true)
          .describe('Append mt=8 (media type: software), marking the link as pointing at an app. Defaults to true, matching the source page\'s checkbox (checked by default).'),
        includeQr: z
          .boolean()
          .default(false)
          .describe('Also render the URL as a QR code PNG and return it as image bytes. Defaults to false (URL + params only).'),
      },
    },
    async (args) => {
      try {
        const result = buildAppStoreLink(args);
        const pngBuffer = result._qrPngBuffer;
        delete result._qrPngBuffer;
        const meta = toolResult.ok(result);
        if (!pngBuffer) return meta;
        const bin = outputStore.emitBinaryOutput({
          buffer: pngBuffer,
          mimeType: 'image/png',
          filename: `app-store-qr-${result.appId}.png`,
        });
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
  buildAppStoreLink,
  buildLink,
  extractAppId,
  qrMatrix,
  renderQrPng,
  gmul,
  rsGenerator,
  rsEncode,
  EC_M,
  ALIGN,
  EXP,
  LOG,
  MAX_QR_BYTES,
  QR_CANVAS_BASE_PX,
  MAX_APP_ID_DIGITS,
  MAX_TOKEN_CHARS,
};
