'use strict';

// Ported from nginx/sites/goai/tools/favicon.html's inline <script> (website_front
// repo) -- a browser-<canvas> favicon-set generator, run here with
// @napi-rs/canvas instead of the DOM canvas. The four drawing helpers
// (square/resize/onBackground/padded), the hand-built ICO container, the
// manifest() object shape and the snippet() HTML block are all copied over
// with the same behaviour, verified against the source line-for-line below.
//
// One structural difference from the source, forced by "no shared
// filesystem, no user interaction": the source reads $("bg").value /
// $("theme").value / $("maskable").checked / $("name").value / $("short").value
// straight off DOM controls inside onBackground()/padded()/manifest()/snippet();
// those are plain function parameters here instead. Every value they read
// is otherwise used identically.

const { z } = require('zod');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const toolResult = require('../../utils/toolResult');
const byteLimits = require('../../utils/byteLimits');
const outputStore = require('../../utils/outputStore');

// ---- hex colour handling ---------------------------------------------------
// The source only ever gets a colour from <input type="color">, which always
// hands back a lowercase 6-digit "#rrggbb" -- there is no browser leniency to
// reproduce. Accepted here a little more liberally (# optional, 3- or
// 6-digit, any case) since callers are LLMs typing a literal rather than a
// colour-picker, then normalised to that same canonical "#rrggbb" shape
// before it goes anywhere -- into canvas fillStyle, into the manifest JSON,
// or into a size comparison.
const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
function normalizeHex(value, field) {
  const m = HEX_RE.exec(String(value).trim());
  if (!m) throw new Error(`${field}: "${value}" is not a hex colour. Use a value like #ffffff or #fff.`);
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return '#' + h;
}

// ---- canvas drawing helpers, exact port of the source's four functions ----

function canvasOf(w, h) {
  return createCanvas(w, h);
}

// A single drawImage from 1024 to 16 throws away almost every sample it
// reads. Halving repeatedly averages four neighbours a step, which is what
// keeps a thin stroke alive at favicon sizes. (Verified identical to the
// source's resize(): same while condition, same Math.max(1, Math.round(...))
// halving, same final draw onto a target x target canvas.)
function resize(src, target) {
  let cur = src;
  while (cur.width / 2 >= target) {
    const half = canvasOf(Math.max(1, Math.round(cur.width / 2)), Math.max(1, Math.round(cur.height / 2)));
    const hc = half.getContext('2d');
    hc.imageSmoothingEnabled = true;
    hc.imageSmoothingQuality = 'high';
    hc.drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  const out = canvasOf(target, target);
  const oc = out.getContext('2d');
  oc.imageSmoothingEnabled = true;
  oc.imageSmoothingQuality = 'high';
  oc.drawImage(cur, 0, 0, target, target);
  return out;
}

// side = max(w, h); draws the source centred on a side*side canvas that is
// left transparent (no fillRect first) -- unlike a flatten-to-background
// step, this stage stays transparent on purpose so alpha survives into
// resize() for every size except the one that's deliberately flattened.
function square(source) {
  const side = Math.max(source.width, source.height);
  const c = canvasOf(side, side);
  const ctx = c.getContext('2d');
  ctx.drawImage(source, Math.round((side - source.width) / 2), Math.round((side - source.height) / 2));
  return c;
}

// Used only for the 180px Apple touch icon: iOS paints an alpha channel
// black instead of honouring it, so that one file gets flattened onto the
// background colour before encoding.
function onBackground(canvas, bg) {
  const c = canvasOf(canvas.width, canvas.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, 0, 0);
  return c;
}

// Maskable mode only (192/512 manifest icons): fills the background colour,
// then draws the already-resized icon scaled into a centred inner square at
// 80% of the width. Android's real safe zone is the inscribed *circle* of
// that same 80% box, but this reproduces the source's square-pad behaviour
// exactly rather than "fixing" it to a circle -- the source never clips to a
// circle either, it only draws one as an overlay in its own live preview,
// which has no equivalent here since there is no interactive canvas to look
// at.
function padded(canvas, bg) {
  const c = canvasOf(canvas.width, canvas.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  const inner = Math.round(c.width * 0.8);
  const off = Math.round((c.width - inner) / 2);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, off, off, inner, inner);
  return c;
}

function png(canvas) {
  return canvas.toBuffer('image/png');
}

// ICO is a six-byte directory, a sixteen-byte entry per image, then the
// payloads. PNG payloads are legal and are what every current browser
// reads, so there is no BMP encoder here -- exact port of the source's
// ico(), just written against a Buffer/DataView instead of a Uint8Array.
function ico(entries) {
  let total = 6 + entries.length * 16;
  entries.forEach((e) => { total += e.data.length; });
  const buf = Buffer.alloc(total);
  buf.writeUInt16LE(0, 0);              // reserved
  buf.writeUInt16LE(1, 2);              // type: 1 = icon
  buf.writeUInt16LE(entries.length, 4); // image count
  let offset = 6 + entries.length * 16;
  entries.forEach((e, i) => {
    const p = 6 + i * 16;
    buf[p] = e.size >= 256 ? 0 : e.size;     // 0 means 256
    buf[p + 1] = e.size >= 256 ? 0 : e.size;
    buf[p + 2] = 0;
    buf[p + 3] = 0;
    buf.writeUInt16LE(1, p + 4);   // colour planes
    buf.writeUInt16LE(32, p + 6);  // bits per pixel
    buf.writeUInt32LE(e.data.length, p + 8);
    buf.writeUInt32LE(offset, p + 12);
    e.data.copy(buf, offset);
    offset += e.data.length;
  });
  return buf;
}

// Exact port of the source's manifest(), minus reading $("...").value --
// name/shortName/theme/bg/maskable arrive as parameters instead.
function manifest(name, shortName, theme, bg, maskable) {
  const purpose = maskable ? 'maskable' : 'any';
  return JSON.stringify(
    {
      name: name || 'My site',
      short_name: shortName || name || 'My site',
      icons: [
        { src: '/web-app-manifest-192x192.png', sizes: '192x192', type: 'image/png', purpose },
        { src: '/web-app-manifest-512x512.png', sizes: '512x512', type: 'image/png', purpose },
      ],
      theme_color: theme,
      background_color: bg,
      display: 'standalone',
    },
    null,
    2
  );
}

// Exact port of the source's snippet(): five lines, only the '"' in the
// short name is escaped (matches the source's /"/g -> "&quot;" -- other
// HTML-significant characters in the short name are not escaped, same as
// the source).
function snippet(shortName, name) {
  const title = (shortName || name || 'My site').replace(/"/g, '&quot;');
  return (
    '<link rel="icon" href="/favicon.ico" sizes="32x32">\n' +
    '<link rel="icon" type="image/png" href="/favicon-96x96.png" sizes="96x96">\n' +
    '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">\n' +
    '<meta name="apple-mobile-web-app-title" content="' + title + '">\n' +
    '<link rel="manifest" href="/site.webmanifest">'
  );
}

const TABLE = [
  ['favicon.ico', '16, 32, 48', 'Tabs, bookmarks, anything that asks for /favicon.ico'],
  ['favicon-96x96.png', '96', 'Modern browsers that prefer a PNG'],
  ['apple-touch-icon.png', '180', 'iOS home screen, flattened onto your background'],
  ['web-app-manifest-192x192.png', '192', 'Installed web app, Android launcher'],
  ['web-app-manifest-512x512.png', '512', 'Installed web app, Android launcher'],
  ['site.webmanifest', '—', 'Installed web app, Android launcher'],
];

// Builds the full favicon set from one source image. Mirrors the source
// page's zipBtn click handler (square -> per-size resize -> ico()/png()
// encode -> manifest()/snippet()), just returning the six files (plus the
// HTML snippet as a string) instead of driving a save-as-zip.
async function generateFaviconSet(input) {
  // The schema declares these same defaults (applied by the MCP SDK's zod
  // parse before this function ever sees the input); repeated here as a
  // plain `||` fallback so a direct/unit-test call with a partial object
  // behaves identically to a real tool call.
  const bg = normalizeHex(input.backgroundColor || '#ffffff', 'backgroundColor');
  const theme = normalizeHex(input.themeColor || '#0a0a0c', 'themeColor');
  const name = input.siteName || 'My site';
  const shortName = input.shortName || '';
  const maskable = input.maskablePadding !== false;

  let source;
  try {
    const raw = byteLimits.decode(input.imageBase64);
    source = await loadImage(raw);
  } catch (err) {
    return { error: `That file could not be read as an image (${err.message}).` };
  }

  // square() below allocates a max(w,h) x max(w,h) canvas, so the cost is
  // driven by the longer side rather than the pixel count -- see the same
  // guard (and the 221-byte / 3.6 GB case behind it) in app-icon.js.
  // @napi-rs/canvas's loadImage() enforces no dimension limit itself.
  // Reported through this function's own { error } channel rather than as a
  // throw, matching how it already reports an undecodable input.
  try {
    byteLimits.assertSquarableSide(source.width, source.height, 'generate_favicon_set');
    byteLimits.assertPixelBudget(source.width, source.height, 'generate_favicon_set');
  } catch (err) {
    return { error: err.message };
  }

  const base = square(source);

  const icoEntries = [16, 32, 48].map((size) => ({ size, data: png(resize(base, size)) }));
  const files = [];
  files.push({ name: 'favicon.ico', mimeType: 'image/x-icon', data: ico(icoEntries) });
  files.push({ name: 'favicon-96x96.png', mimeType: 'image/png', data: png(resize(base, 96)) });
  // iOS paints an alpha channel black, so this one is flattened first.
  files.push({ name: 'apple-touch-icon.png', mimeType: 'image/png', data: png(onBackground(resize(base, 180), bg)) });

  const m192 = resize(base, 192);
  const m512 = resize(base, 512);
  files.push({
    name: 'web-app-manifest-192x192.png',
    mimeType: 'image/png',
    data: png(maskable ? padded(m192, bg) : m192),
  });
  files.push({
    name: 'web-app-manifest-512x512.png',
    mimeType: 'image/png',
    data: png(maskable ? padded(m512, bg) : m512),
  });

  const manifestText = manifest(name, shortName, theme, bg, maskable);
  files.push({ name: 'site.webmanifest', mimeType: 'application/manifest+json', data: Buffer.from(manifestText, 'utf8') });

  const snippetText = snippet(shortName, name);

  const rows = TABLE.map((r) => ({ file: r[0], sizes: r[1], usedFor: r[2] }));

  // Same threshold and message as the source's render(): base.width is the
  // side length *after* squaring, i.e. max(original width, original height).
  const warning =
    base.width < 512
      ? `That image is ${base.width} pixels across. 512 or more gives a cleaner 512 icon.`
      : null;

  return {
    files,
    manifest: manifestText,
    snippet: snippetText,
    table: rows,
    sourceWidth: source.width,
    sourceHeight: source.height,
    squaredSide: base.width,
    maskablePadding: maskable,
    themeColor: theme,
    backgroundColor: bg,
    warning,
  };
}

const inputSchema = {
  imageBase64: z
    .string()
    .min(1)
    .describe('Source image, base64-encoded. Any raster/SVG format @napi-rs/canvas can decode (PNG, JPEG, WebP, GIF, SVG). May be non-square and may carry transparency -- it is centred on a square canvas before anything else happens to it. Capped by this server\'s per-input byte limit.'),
  siteName: z
    .string()
    .max(45)
    .default('My site')
    .describe('Full site name, used as the manifest\'s "name" field and as the fallback for short_name / the apple-mobile-web-app-title meta tag when shortName is empty.'),
  shortName: z
    .string()
    .max(12)
    .default('')
    .describe('Short name for a home-screen label (roughly 12 characters fit). Used as the manifest\'s "short_name" and in the apple-mobile-web-app-title meta tag; falls back to siteName when empty.'),
  themeColor: z
    .string()
    .min(1)
    // Colour literals. Bounded because normalizeHex() echoes the rejected
    // value straight back into its error message.
    .max(byteLimits.MAX_SHORT_TEXT_CHARS)
    .default('#0a0a0c')
    .describe('Hex colour (# optional, 3- or 6-digit) written to the manifest\'s theme_color field. Purely metadata -- never painted onto any icon.'),
  backgroundColor: z
    .string()
    .min(1)
    .max(byteLimits.MAX_SHORT_TEXT_CHARS)
    .default('#ffffff')
    .describe('Hex colour (# optional, 3- or 6-digit) used three ways: the manifest\'s background_color field, the flatten colour behind the apple-touch-icon (iOS does not honour alpha there), and the padding colour around the maskable-cropped manifest icons.'),
  maskablePadding: z
    .boolean()
    .default(true)
    .describe('When true (default), the 192x192 and 512x512 manifest icons are padded: the artwork is shrunk to a centred 80%-width square on the background colour, matching Android\'s maskable-icon safe zone, and the manifest icons\' "purpose" is set to "maskable". When false, those two icons are the plain resized artwork with "purpose": "any".'),
};

function register(server) {
  server.registerTool(
    'generate_favicon_set',
    {
      title: 'Generate a favicon and web-app-manifest set',
      description:
        'Turns one source image into a complete favicon set: favicon.ico (a real multi-resolution ' +
        'ICO container holding 16, 32 and 48px PNG-encoded entries -- not a single-size file with an ' +
        '.ico extension), favicon-96x96.png, apple-touch-icon.png (180px, flattened onto ' +
        'backgroundColor because iOS paints transparency black there), web-app-manifest-192x192.png ' +
        'and web-app-manifest-512x512.png (optionally padded to Android\'s maskable safe zone -- the ' +
        'artwork shrunk to a centred 80%-width square on the background colour, reproducing the ' +
        'source tool\'s square padding rather than clipping to the actual inscribed-circle safe area), ' +
        'site.webmanifest, and the exact 5-line HTML <head> snippet (favicon.ico link, ' +
        'favicon-96x96.png link, apple-touch-icon link, apple-mobile-web-app-title meta, manifest ' +
        'link) ready to paste. A non-square source is centred on a transparent square canvas first, ' +
        'so nothing is stretched. Ported from GO AI\'s browser-based favicon tool, run server-side ' +
        'with @napi-rs/canvas instead of a DOM <canvas>. Every PNG and the .ico are small (a few KB ' +
        'to worst-case a couple hundred KB), so all six files are returned individually rather than ' +
        'zipped -- each name matters (favicon.ico and site.webmanifest belong at the site root) and ' +
        'there is no batching benefit to a ZIP at this size. The JSON result carries the manifest ' +
        'JSON text, the HTML snippet text, a per-file table of what each output is for, and a ' +
        'warning when the source is smaller than 512px on its longer side (the 512 icon will be ' +
        'upscaled). Fails with a clear message rather than throwing if the input cannot be decoded ' +
        'as an image.',
      inputSchema,
    },
    async (args) => {
      try {
        const result = await generateFaviconSet(args);
        if (result.error) return toolResult.fail(result.error);

        const meta = toolResult.ok({
          manifest: result.manifest,
          snippet: result.snippet,
          table: result.table,
          sourceWidth: result.sourceWidth,
          sourceHeight: result.sourceHeight,
          squaredSide: result.squaredSide,
          maskablePadding: result.maskablePadding,
          themeColor: result.themeColor,
          backgroundColor: result.backgroundColor,
          warning: result.warning,
        });

        let binContent = [];
        for (const f of result.files) {
          const bin = outputStore.emitBinaryOutput({ buffer: f.data, mimeType: f.mimeType, filename: f.name });
          binContent = binContent.concat(bin.content);
        }

        return { content: [...meta.content, ...binContent], structuredContent: meta.structuredContent };
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );
}

module.exports = {
  register,
  toolCount: 1,
  generateFaviconSet,
  square,
  resize,
  onBackground,
  padded,
  ico,
  manifest,
  snippet,
  normalizeHex,
  inputSchema,
};
