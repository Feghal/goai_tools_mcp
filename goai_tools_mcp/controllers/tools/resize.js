'use strict';

const { z } = require('zod');
const sharp = require('sharp');
const toolResult = require('../../utils/toolResult');
const byteLimits = require('../../utils/byteLimits');
const outputStore = require('../../utils/outputStore');
const { zip } = require('../../utils/zip');

// Ported from nginx/sites/goai/tools/resize.html's inline <script> and its
// `id="resize-presets"` JSON block. Every {dir, sizes, names?} entry below
// is copied verbatim from that block -- these are the exact pixel
// dimensions the page ships, not independently sourced.
const PRESETS = {
  appstore69: { dir: 'app-store', sizes: [[1320, 2868]] },
  appstore67: { dir: 'app-store', sizes: [[1290, 2796]] },
  appstoreIpad: { dir: 'app-store', sizes: [[2064, 2752]] },
  androidIcon: {
    dir: 'android',
    sizes: [[48, 48], [72, 72], [96, 96], [144, 144], [192, 192]],
    names: ['mipmap-mdpi', 'mipmap-hdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi'],
  },
  favicon: { dir: 'favicon', sizes: [[16, 16], [32, 32], [48, 48], [180, 180], [192, 192], [512, 512]] },
  og: { dir: 'social', sizes: [[1200, 630]] },
  xcard: { dir: 'social', sizes: [[1200, 628]] },
  linkedin: { dir: 'social', sizes: [[1200, 627]] },
  igSquare: { dir: 'social', sizes: [[1080, 1080]] },
  igPortrait: { dir: 'social', sizes: [[1080, 1350]] },
  igStory: { dir: 'social', sizes: [[1080, 1920]] },
  youtube: { dir: 'social', sizes: [[1280, 720]] },
  custom: { dir: 'custom', sizes: [] },
};
const PRESET_KEYS = Object.keys(PRESETS);

// Source's FITS = ['contain', 'cover', 'stretch']; sharp's `fit` option
// spells the stretch case 'fill'.
const FIT_TO_SHARP = { contain: 'contain', cover: 'cover', stretch: 'fill' };
const FIT_VALUES = Object.keys(FIT_TO_SHARP);

// ---------------------------------------------------------------------------
// Batch bounds
// ---------------------------------------------------------------------------
// This is the widest fan-out in the whole service: every input image is
// resized to EVERY size in the chosen preset, and all of the results are held
// in memory at once (the `files` array) and then copied again into the ZIP.
// The image count alone is the wrong thing to bound, because presets differ
// enormously in what one image costs:
//   favicon      6 sizes summing to  0.31 MP  per image
//   og           1 size  of          0.76 MP  per image
//   appstoreIpad 1 size  of          5.68 MP  per image
// The old `.max(200)` therefore permitted 200 x 5.68 MP = 1136 MP of PNG
// output from one call -- comfortably a gigabyte of retained buffers, twice
// over once zip() concatenates them.

// 60 images is well past any real batch (a full App Store screenshot set is
// 10 per device size) while keeping the per-image bookkeeping bounded.
const MAX_IMAGES = 60;

// The bound that actually matters: total output PIXELS across images x sizes.
// 48 MP is ~8 appstoreIpad screenshots, ~63 og cards, or ~150 favicon sets --
// each of which is a generous real batch. Checked BEFORE any decoding, from
// the preset table alone, so an over-large request costs nothing to reject.
const MAX_TOTAL_OUTPUT_PIXELS = 48 * 1000 * 1000;

// PNG bytes are content-dependent in a way pixels are not: photographic noise
// can make a 5 MP PNG 20 MB. This running cap is the exact backstop on what
// `files` (and then the ZIP copy of it) can hold. 48 MB retained + 48 MB in
// the archive = ~96 MB, inside the ~195 MB this tool is budgeted.
const MAX_TOTAL_OUTPUT_BYTES = 48 * 1000 * 1000;

// Exact port of the source's baseName(name): strip a trailing extension,
// then collapse anything that isn't a word char/dot/dash into a dash.
function baseName(name) {
  return name.replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.-]+/g, '-');
}

// Exact port of the source's sizesFor(): the custom preset synthesizes a
// single [w, h] pair from the width/height fields; every other preset is
// used as declared.
function sizesFor(presetKey, customWidth, customHeight) {
  const preset = PRESETS[presetKey];
  if (presetKey === 'custom') {
    return { dir: preset.dir, sizes: [[customWidth, customHeight]], names: null };
  }
  return { dir: preset.dir, sizes: preset.sizes, names: preset.names || null };
}

// Exact port of the source's per-size filename rule: a preset with named
// slots (only androidIcon) gets one file per named subfolder; everything
// else gets `<dir>/<baseName>-<w>x<h>.png`.
function fileNameFor(spec, sourceName, size, sizeIndex) {
  const folder = spec.names ? `${spec.dir}/${spec.names[sizeIndex]}` : spec.dir;
  return spec.names
    ? `${folder}/${baseName(sourceName)}.png`
    : `${folder}/${baseName(sourceName)}-${size[0]}x${size[1]}.png`;
}

// Resizes every input image to every size in the chosen preset (or the
// custom width/height) under the chosen fit, PNG-encodes each result, and
// zips the lot. Mirrors the source page's render()/build() pipeline:
//   - fit 'contain' matches its whole-picture-plus-padding behaviour;
//   - fit 'cover' matches its fill-and-crop behaviour;
//   - fit 'stretch' matches its distort-to-fill behaviour (sharp 'fill').
// Two deliberate deviations from the browser version, both because this
// runs through sharp/libvips rather than a <canvas>:
//   1. The source manually downsamples in halving steps before its final
//      drawImage() because canvas has no quality-aware filter for a large
//      single jump. sharp's default resize kernel (lanczos3) is already a
//      quality downsampler in one pass, so the halving cascade is redundant
//      here and is not reproduced.
//   2. `.rotate()` (no args) is called before resizing so a photo carrying
//      EXIF orientation comes out right-side up, matching how a browser
//      decodes the same file into an <img> before it ever reaches the
//      source's <canvas>.
// A failed decode throws with the offending file named, rather than being
// silently dropped the way the source's `img.onerror` drops it and keeps
// going -- a batch tool's caller needs to know an input didn't make it in,
// not silently receive fewer files than it asked for.
async function resizeImages(input) {
  const spec = sizesFor(input.preset, input.customWidth, input.customHeight);
  const sharpFit = FIT_TO_SHARP[input.fit];
  const background = input.fit === 'contain' ? input.paddingColor : undefined;

  // Fan-out check FIRST, from the preset table and the image count alone --
  // no decoding, no allocation. An over-large request is refused for free.
  const pixelsPerImage = spec.sizes.reduce((sum, [w, h]) => sum + w * h, 0);
  const totalOutputPixels = pixelsPerImage * input.images.length;
  // `> limit` is false for NaN, so a non-finite total (reachable only on a
  // direct call that skipped the schema's customWidth/customHeight defaults)
  // would slip past the check silently. Reject it explicitly instead.
  if (!Number.isFinite(totalOutputPixels) || pixelsPerImage <= 0) {
    throw new Error(
      `The "${input.preset}" preset resolved to no usable output size` +
        (input.preset === 'custom' ? ' -- customWidth and customHeight are required for the custom preset.' : '.')
    );
  }
  if (totalOutputPixels > MAX_TOTAL_OUTPUT_PIXELS) {
    throw new Error(
      `This call would produce ${input.images.length} images x ${spec.sizes.length} size(s) = ` +
        `${totalOutputPixels} output pixels, over the ${MAX_TOTAL_OUTPUT_PIXELS}-pixel per-call limit. ` +
        `The "${input.preset}" preset costs ${pixelsPerImage} pixels per image, so at most ` +
        `${Math.floor(MAX_TOTAL_OUTPUT_PIXELS / pixelsPerImage)} image(s) fit in one call. ` +
        'Split the batch across several calls.'
    );
  }

  // Source sorts `loaded` by name before building outputs; reproduced here
  // even though it only affects file/preview ordering, not correctness.
  // decodeBatch enforces the aggregate decoded-input cap across all images as
  // well as the per-image one, and checks it from the base64 lengths before
  // allocating even the first buffer.
  const buffers = byteLimits.decodeBatch(input.images, (im) => im.imageBase64);
  const items = input.images
    .map((im, i) => ({ name: im.name, buffer: buffers[i] }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const files = [];
  const outputs = [];
  let totalOutputBytes = 0;

  for (const item of items) {
    let pipelineBase;
    try {
      // sharpLimits() replaces libvips' ~1.07 GB default limitInputPixels
      // with this container's budget, so a decompression bomb (a 748 KB PNG
      // that decodes to 16000x16000) is refused at decode rather than
      // decoded first. metadata() reads the header only, so the explicit
      // dimension check below it can give a message naming the real numbers
      // instead of libvips' bare "Input image exceeds pixel limit".
      const meta = await sharp(item.buffer, { limitInputPixels: false }).metadata();
      byteLimits.assertPixelBudget(meta.width, meta.height, `"${item.name}"`);
      pipelineBase = sharp(item.buffer, byteLimits.sharpLimits()).rotate();
      await pipelineBase.metadata();
    } catch (err) {
      if (err instanceof byteLimits.ImageTooLargeError) throw err;
      throw new Error(`"${item.name}" could not be read as an image (${err.message}).`);
    }

    for (let si = 0; si < spec.sizes.length; si++) {
      const size = spec.sizes[si];
      const [width, height] = size;
      const fileName = fileNameFor(spec, item.name, size, si);

      let outBuffer;
      try {
        outBuffer = await sharp(item.buffer, byteLimits.sharpLimits())
          .rotate()
          .resize({ width, height, fit: sharpFit, background })
          .png()
          .toBuffer();
      } catch (err) {
        throw new Error(`"${item.name}" at ${width}x${height} failed to resize (${err.message}).`);
      }

      // Exact backstop on retained bytes: the pixel check above cannot know
      // how well any given image's content will compress as PNG.
      totalOutputBytes += outBuffer.length;
      if (totalOutputBytes > MAX_TOTAL_OUTPUT_BYTES) {
        throw new Error(
          `The resized output passed ${MAX_TOTAL_OUTPUT_BYTES} bytes at "${fileName}" and was stopped. ` +
            'These images compress poorly as PNG at the requested sizes -- send fewer per call.'
        );
      }

      files.push({ name: fileName, data: outBuffer });
      outputs.push({
        source: item.name,
        file: fileName,
        width,
        height,
        bytes: outBuffer.length,
      });
    }
  }

  const zipBuffer = zip(files);

  return {
    buffer: zipBuffer,
    mimeType: 'application/zip',
    filename: 'resized.zip',
    stats: {
      imagesIn: items.length,
      filesOut: files.length,
      sizes: spec.sizes.length,
      preset: input.preset,
      fit: input.fit,
      paddingColor: input.fit === 'contain' ? input.paddingColor : null,
      outputs,
    },
  };
}

function register(server) {
  server.registerTool(
    'resize_images',
    {
      title: 'Batch image resizer with real presets',
      description:
        'Resizes a batch of 1+ images to a named real-world preset (App Store screenshots, ' +
        'Open Graph/social cards, Android launcher icon densities, a favicon set) or a custom ' +
        'width/height, using contain (whole picture, padded), cover (fills the frame, crops ' +
        'overflow) or stretch (distorts to fit) fitting. Each resized image is PNG-encoded ' +
        '(EXIF/ICC metadata stripped on re-encode, matching the source page) and every image is ' +
        'auto-rotated per its embedded EXIF orientation before resizing. All outputs are packaged ' +
        'into one uncompressed ZIP (PNG bytes are already compressed, so a second pass would not ' +
        'shrink them), foldered by preset (e.g. "social/photo-1200x630.png", or ' +
        '"android/mipmap-hdpi/icon.png" for the Android density preset, which names each size\'s ' +
        'folder after its density instead of suffixing the pixel size). This always returns as a ' +
        'resource_link (a batch ZIP is never small enough, or singular enough, to inline) -- fetch ' +
        'the link to get the archive. Per-file output dimensions and byte sizes are reported in ' +
        'the JSON result. Each input image (base64) is capped by this server\'s per-input byte limit.',
      inputSchema: {
        images: z
          .array(
            z.object({
              // Bounded because it becomes a path inside the ZIP and is
              // echoed into per-file error messages; a filename has no
              // legitimate reason to run long.
              name: z.string().min(1).max(255).describe('Original filename (extension optional); used to derive each output filename.'),
              imageBase64: z.string().min(1).describe('Base64-encoded source image bytes (any format sharp can decode: PNG, JPEG, WebP, GIF, AVIF, TIFF, ...).'),
            })
          )
          .min(1)
          .max(MAX_IMAGES)
          .describe(
            `One to ${MAX_IMAGES} images. Each is resized independently to every size in the chosen preset. ` +
              `A call is additionally capped at ${MAX_TOTAL_OUTPUT_PIXELS} total output pixels across images x sizes, ` +
              'so a preset with large or numerous sizes admits fewer images than one with small ones.'
          ),
        preset: z
          .enum(PRESET_KEYS)
          .default('og')
          .describe(
            'Which size(s) to produce for every image. ' +
              'appstore69: App Store screenshot, 6.9" iPhone, 1320x2868. ' +
              'appstore67: App Store screenshot, 6.7" iPhone, 1290x2796. ' +
              'appstoreIpad: App Store screenshot, 13" iPad, 2064x2752. ' +
              'androidIcon: Android launcher icon, 5 densities (48/72/96/144/192px, each output foldered as mipmap-mdpi/hdpi/xhdpi/xxhdpi/xxxhdpi). ' +
              'favicon: favicon set, 16/32/48/180/192/512px. ' +
              'og: Open Graph card, 1200x630. ' +
              'xcard: X (Twitter) summary card, 1200x628. ' +
              'linkedin: LinkedIn share image, 1200x627. ' +
              'igSquare: Instagram square post, 1080x1080. ' +
              'igPortrait: Instagram portrait post, 1080x1350. ' +
              'igStory: Instagram story, 1080x1920. ' +
              'youtube: YouTube thumbnail, 1280x720. ' +
              'custom: a single arbitrary size taken from customWidth/customHeight.'
          ),
        fit: z
          .enum(FIT_VALUES)
          .default('contain')
          .describe(
            "How each image fills its target box. 'contain' keeps the whole picture and pads " +
              "the gap with paddingColor. 'cover' fills the box and crops whatever hangs over. " +
              "'stretch' distorts the image to the exact box, ignoring aspect ratio."
          ),
        customWidth: z
          .number()
          .int()
          .min(1)
          .max(8000)
          .default(1200)
          .describe('Target width in px. Only used when preset is "custom".'),
        customHeight: z
          .number()
          .int()
          .min(1)
          .max(8000)
          .default(630)
          .describe('Target height in px. Only used when preset is "custom".'),
        paddingColor: z
          .string()
          .min(1)
          // A colour literal reaching sharp's `background` option, and echoed
          // back in the stats object.
          .max(byteLimits.MAX_SHORT_TEXT_CHARS)
          .default('#ffffff')
          .describe('Hex color (e.g. "#ffffff") used to pad the frame when fit is "contain". Ignored for "cover" and "stretch".'),
      },
    },
    async (args) => {
      try {
        const result = await resizeImages(args);
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

module.exports = {
  register,
  toolCount: 1,
  resizeImages,
  PRESETS,
  sizesFor,
  baseName,
  MAX_IMAGES,
  MAX_TOTAL_OUTPUT_PIXELS,
  MAX_TOTAL_OUTPUT_BYTES,
};
