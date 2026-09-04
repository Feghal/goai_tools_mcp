'use strict';

const { z } = require('zod');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const toolResult = require('../../utils/toolResult');
const byteLimits = require('../../utils/byteLimits');
const outputStore = require('../../utils/outputStore');
const { zip } = require('../../utils/zip');

// Ported from nginx/sites/goai/tools/app-icon.html's inline <script> and its
// `id="icon-sizes"` JSON block. Every pixel size below is copied verbatim
// from that block. @napi-rs/canvas's Canvas2D surface matches the browser
// closely enough (fillRect/drawImage/getImageData+putImageData/
// imageSmoothingEnabled+imageSmoothingQuality/toBuffer) that every pixel
// operation is reproduced as the same sequence of canvas calls rather than
// reimplemented as raw pixel math -- confirmed against this exact build
// that assigning a float luma into ImageData.data and compositing via
// globalAlpha round/clamp identically to a browser's Uint8ClampedArray.
const SIZES = {
  plain: [16, 20, 29, 32, 40, 48, 58, 60, 64, 72, 76, 80, 87, 96, 120, 128, 144, 152, 167, 180, 192, 256, 512, 1024],
  android: [
    { dir: 'mipmap-mdpi', px: 48 },
    { dir: 'mipmap-hdpi', px: 72 },
    { dir: 'mipmap-xhdpi', px: 96 },
    { dir: 'mipmap-xxhdpi', px: 144 },
    { dir: 'mipmap-xxxhdpi', px: 192 },
  ],
};

const WHERE_IOS = 'Xcode asset catalogue';
const WHERE_ANDROID = 'Android res folder';
const WHERE_PLAIN = 'Everything else';

function canvasOf(w, h) {
  return createCanvas(w, h);
}

// A single drawImage from 1024 to 40 discards almost every sample it reads.
// Halving repeatedly averages four neighbours per step, which is what a box
// filter does, and keeps thin strokes alive at the small sizes. Every call
// starts fresh from whatever `src` it is given (always `base` in plan()
// below) -- resized outputs never chain off a previously resized canvas.
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

// Apple applies the colour to a tinted icon, so what we supply is a
// luminance map. Rec. 709 coefficients, which is what "greyscale" means for
// display-referred sRGB. Alpha is left untouched.
function tinted(canvas) {
  const out = canvasOf(canvas.width, canvas.height);
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = y;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

// Not a design, and the page says so: the artwork over a darker ground.
// `canvas` (built off flatten, which always fills the full frame first) is
// always fully opaque, so this is approximately out_rgb = round(rgb*0.82) --
// but that formula is only a gloss on what the source actually does; the
// literal operations here (fillRect black, globalAlpha=0.82, drawImage) are
// ported byte-for-byte, and this library's premultiplied-alpha compositing
// can land a channel ±1 off a hand-computed round(rgb*0.82) (confirmed by
// direct test), same as it would across two different browsers' canvas
// backends. Matching the source's literal call sequence is the correct
// target here, not the shorthand formula.
function darkened(canvas) {
  const out = canvasOf(canvas.width, canvas.height);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.globalAlpha = 0.82;
  ctx.drawImage(canvas, 0, 0);
  ctx.globalAlpha = 1;
  return out;
}

function contentsJson(mode) {
  const images = [{ filename: 'AppIcon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }];
  if (mode !== 'none') {
    images.push({
      appearances: [{ appearance: 'luminosity', value: 'dark' }],
      filename: 'AppIcon-Dark.png',
      idiom: 'universal',
      platform: 'ios',
      size: '1024x1024',
    });
  }
  if (mode === 'all') {
    images.push({
      appearances: [{ appearance: 'luminosity', value: 'tinted' }],
      filename: 'AppIcon-Tinted.png',
      idiom: 'universal',
      platform: 'ios',
      size: '1024x1024',
    });
  }
  return JSON.stringify({ images, info: { author: 'xcode', version: 1 } }, null, 2);
}

// Centers the source on a bg-filled side*side square canvas (side =
// max(w,h)) -- letterboxing, not stretching -- so a non-square source is
// padded instead of distorted.
function flatten(img, bg) {
  const side = Math.max(img.width, img.height);
  const c = canvasOf(side, side);
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, side, side);
  ctx.drawImage(img, Math.round((side - img.width) / 2), Math.round((side - img.height) / 2));
  return c;
}

// Exact port of the source's checkAlpha(): probes at most a 256x256 sample
// (never the full image) for any pixel with alpha < 255.
function checkAlpha(img) {
  const pw = Math.min(img.width, 256);
  const ph = Math.min(img.height, 256);
  const probe = canvasOf(pw, ph);
  const ctx = probe.getContext('2d');
  ctx.drawImage(img, 0, 0, pw, ph);
  const d = ctx.getImageData(0, 0, pw, ph).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

function planItems(base, mode) {
  const light = resize(base, 1024);
  const items = [];
  const manifest = [];

  items.push({ name: 'AppIcon.appiconset/AppIcon.png', canvas: light });
  manifest.push({ where: WHERE_IOS, path: 'AppIcon.appiconset/AppIcon.png', width: 1024, height: 1024 });

  if (mode !== 'none') {
    const dark = darkened(light);
    items.push({ name: 'AppIcon.appiconset/AppIcon-Dark.png', canvas: dark });
    manifest.push({ where: WHERE_IOS, path: 'AppIcon.appiconset/AppIcon-Dark.png', width: 1024, height: 1024 });
  }
  if (mode === 'all') {
    const tint = tinted(light);
    items.push({ name: 'AppIcon.appiconset/AppIcon-Tinted.png', canvas: tint });
    manifest.push({ where: WHERE_IOS, path: 'AppIcon.appiconset/AppIcon-Tinted.png', width: 1024, height: 1024 });
  }

  items.push({ name: 'AppIcon.appiconset/Contents.json', text: contentsJson(mode) });
  manifest.push({ where: WHERE_IOS, path: 'AppIcon.appiconset/Contents.json', width: null, height: null });

  SIZES.android.forEach((a) => {
    items.push({ name: `android/${a.dir}/ic_launcher.png`, canvas: resize(base, a.px) });
    manifest.push({ where: WHERE_ANDROID, path: `android/${a.dir}/ic_launcher.png`, width: a.px, height: a.px });
  });

  SIZES.plain.forEach((px) => {
    items.push({ name: `sizes/icon-${px}.png`, canvas: resize(base, px) });
    manifest.push({ where: WHERE_PLAIN, path: `sizes/icon-${px}.png`, width: px, height: px });
  });

  return { items, manifest };
}

// Builds the full AppIcon.appiconset + Android mipmap set + flat sizes/
// folder from one source image, matching nginx/sites/goai/tools/app-icon.html's
// build()/plan()/encodeAll() pipeline. mode 'none' ships only AppIcon.png;
// 'dark' adds AppIcon-Dark.png; 'all' adds both Dark and Tinted -- exactly
// the source's three <select> options.
async function generateAppIconSet(input) {
  const buffer = byteLimits.decode(input.imageBase64);

  let img;
  try {
    img = await loadImage(buffer);
  } catch (err) {
    throw new Error(`Source image could not be read as an image (${err.message}).`);
  }

  // @napi-rs/canvas's loadImage() applies NO dimension limit of its own, and
  // flatten() below allocates a max(w,h) x max(w,h) square -- so the cost is
  // driven by the LONGER SIDE, not by the source's pixel count. A 1 x 30000
  // strip is a 221-byte PNG and only 30000 pixels (it passes any pixel-count
  // check), yet squares to 30000 x 30000 = 3.6 GB. Both bounds are checked:
  // the side bound catches that strip, the pixel bound catches a big square.
  byteLimits.assertSquarableSide(img.width, img.height, 'generate_app_icon_set');
  byteLimits.assertPixelBudget(img.width, img.height, 'generate_app_icon_set');

  const mode = input.variants;
  const bg = input.backgroundColor;
  const hadAlpha = checkAlpha(img);

  const base = flatten(img, bg);
  const { items, manifest } = planItems(base, mode);

  const files = items.map((item) => ({
    name: item.name,
    data: item.text ? Buffer.from(item.text, 'utf8') : item.canvas.toBuffer('image/png'),
  }));
  const zipBuffer = zip(files);

  // Same two (non-fatal) warnings the source page derives in build(), with
  // the exact wording of its S.notSquare / S.small strings.
  const notSquare =
    img.width !== img.height
      ? `Your image is ${img.width}×${img.height}, which is not square. It has been padded rather than stretched.`
      : null;
  const small =
    Math.max(img.width, img.height) !== 1024
      ? `Your image is ${img.width}×${img.height}. Anything above 1024 is downscaled; anything below is upscaled and will look soft.`
      : null;

  return {
    buffer: zipBuffer,
    mimeType: 'application/zip',
    filename: 'app-icons.zip',
    stats: {
      source: { width: img.width, height: img.height },
      hadAlpha,
      variants: mode,
      backgroundColor: bg,
      filesOut: files.length,
      warnings: { notSquare, small },
      files: manifest,
    },
  };
}

function register(server) {
  server.registerTool(
    'generate_app_icon_set',
    {
      title: 'App icon set generator (iOS + Android)',
      description:
        'Turns one source image into a ZIP containing a complete iOS Xcode AppIcon.appiconset ' +
        '(AppIcon.png at 1024x1024, plus a hand-written Contents.json Xcode accepts, and ' +
        'optionally AppIcon-Dark.png and AppIcon-Tinted.png for the appearance variants modern ' +
        'iOS asks for), a full Android mipmap-mdpi/hdpi/xhdpi/xxhdpi/xxxhdpi set of ic_launcher.png ' +
        'files (48/72/96/144/192px), and a flat sizes/ folder with 24 icon-<px>.png files from ' +
        '16 to 1024px. Any transparency in the source is flattened onto the given background ' +
        'colour first (Apple rejects icons with alpha). A non-square source is centered and ' +
        'letterboxed onto a square canvas rather than stretched. Every output size is produced by ' +
        'repeatedly halving the source (a box-filter-equivalent downscale) before one final resize ' +
        'to the exact target, which keeps small icons sharp instead of muddy. The dark variant is a ' +
        'mechanical darken (source composited at 82% opacity over black) offered as a starting ' +
        'point, not a real design pass -- review it before shipping. The tinted variant is a Rec.709 ' +
        'greyscale luminance map, which is what iOS actually wants for that slot (it applies the ' +
        'colour itself). The JSON result reports the source dimensions, whether it had transparency, ' +
        'the file count, and two non-fatal warnings when the source was not square or not exactly ' +
        '1024px on its longest side. Always returns as a resource_link (a 30+ file ZIP is never ' +
        'small enough to inline) -- fetch the link to get the archive.',
      inputSchema: {
        imageBase64: z
          .string()
          .min(1)
          .describe('Base64-encoded source image bytes (PNG, JPEG, or WebP). 1024x1024 is ideal; anything else is padded to square and/or scaled.'),
        variants: z
          .enum(['none', 'dark', 'all'])
          .default('all')
          .describe(
            "Which iOS appearance variants to include alongside the required light AppIcon.png. " +
              "'none': light only. 'dark': light + AppIcon-Dark.png. 'all': light + AppIcon-Dark.png + AppIcon-Tinted.png. " +
              'Contents.json is written to match whichever set is chosen.'
          ),
        backgroundColor: z
          .string()
          .min(1)
          // A colour literal; anything longer is not one. Bounded because it
          // reaches canvas fillStyle and is echoed back in the stats object.
          .max(byteLimits.MAX_SHORT_TEXT_CHARS)
          .default('#ffffff')
          .describe('CSS/hex colour (e.g. "#ffffff") used to flatten transparency and to pad a non-square source before it is centered onto a square canvas.'),
      },
    },
    async (args) => {
      try {
        const result = await generateAppIconSet(args);
        const bin = outputStore.emitBinaryOutput({
          buffer: result.buffer,
          mimeType: result.mimeType,
          filename: result.filename,
        });
        const meta = toolResult.ok(result.stats);
        return { content: [...meta.content, ...bin.content], structuredContent: meta.structuredContent };
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );
}

module.exports = { register, toolCount: 1, generateAppIconSet, SIZES, contentsJson };
