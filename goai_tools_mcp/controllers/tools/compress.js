'use strict';

const { z } = require('zod');
const sharp = require('sharp');
const toolResult = require('../../utils/toolResult');
const toolAnnotations = require('../../utils/toolAnnotations');
const byteLimits = require('../../utils/byteLimits');
const outputStore = require('../../utils/outputStore');

// Ported from nginx/sites/goai/tools/compress.html's fitCanvas():
//   var max = 1600;
//   var scale = Math.min(1, max / Math.max(source.width, source.height));
// i.e. a bounding-box downscale that never enlarges. sharp's own
// fit:'inside' + withoutEnlargement:true resize (below) is that same rule.
const DEFAULT_MAX_DIMENSION = 1600;

// Ported verbatim from the source's drawCurve():
//   var qs = [100, 10, 55, 80, 30, 90, 70, 40, 95, 60, 85, 20, 75, 50];
// That order is "ends first, then middle" so the curve's shape appears
// early while a human watches it draw point-by-point; a stats-only tool has
// no such concern, so this reports the same 14 levels sorted ascending.
const CURVE_QUALITIES = [100, 10, 55, 80, 30, 90, 70, 40, 95, 60, 85, 20, 75, 50];

// The source's quality slider runs 5-100 (`min="5" max="100"`); mirrored
// here as the schema bound rather than sharp's own wider 1-100 range.
const MIN_QUALITY = 5;
const MAX_QUALITY = 100;
// The source's slider default (`value="75"`).
const DEFAULT_QUALITY = 75;

// maxDimension used to allow 20000, which meant a 20000-px cap performed no
// downscale at all on any realistic input -- the "working" image stayed
// full-size and every encode ran against it. Measured on this exact code: a
// 748 KB 16000x16000 PNG through image_compression_curve at maxDimension
// 20000 peaked at 6.4 GB RSS and took 5.4 s. That is 16x the container's
// entire 400 MB limit, from under a megabyte of input.
//
// 4000 caps one working image at 4000x4000 = 16 MP = 64 MB of RGBA. It is
// 2.5x the source page's own 1600 default and larger than any output
// image_compress is plausibly asked for, so no real use case loses anything.
const MAX_MAX_DIMENSION = 4000;

// image_compression_curve gets its OWN, tighter cap, because it does the same
// encode FOURTEEN times. Measured at the previous shared 4000 cap, with a
// 6000x4000 source and format 'avif': 31 SECONDS and 499 MB RSS -- on a fast
// laptop. The deployment target is one shared vCPU, where that is several
// times slower still, i.e. past the 125 s Cloudflare edge ceiling as well as
// past the 400 MB container limit.
//
// 2000 is a quarter of the pixels (4x less work and 4x less memory per
// encode) and costs the tool nothing real: the curve's whole purpose is
// locating the knee of the size-vs-quality curve, which is a property of the
// image's CONTENT and sits in the same place at 2000px as at 4000px. The
// source page itself only ever samples this curve at its own 1600 default.
const MAX_CURVE_MAX_DIMENSION = 2000;

// image_compression_curve encodes 14 quality levels. Doing all 14 at once
// (the previous Promise.all over the whole list) means 14 simultaneous
// libvips pipelines against the same working image, holding 14 encodes'
// intermediate buffers live together -- that concurrency, not the image size
// alone, is what turned 64 MB of bitmap into gigabytes.
//
// 1 (fully sequential) rather than some small N > 1: the box this runs on has
// ONE shared vCPU, so extra concurrency buys no wall-clock time there while
// multiplying peak memory by N. sharp's own libvips threadpool still uses
// what parallelism the machine has within a single encode.
const CURVE_ENCODE_CONCURRENCY = 1;

const FORMATS = {
  jpeg: { ext: 'jpg', mimeType: 'image/jpeg', encode: (img, quality) => img.jpeg({ quality }) },
  webp: { ext: 'webp', mimeType: 'image/webp', encode: (img, quality) => img.webp({ quality }) },
  avif: { ext: 'avif', mimeType: 'image/avif', encode: (img, quality) => img.avif({ quality }) },
};

// Source: `(originalSize - blob.size) / originalSize * 100`, shown as
// "N% smaller" when positive or "N% larger" when negative. Returned here as
// a single signed number (positive = shrank, negative = grew) since this is
// a machine-consumed field, not a display string.
function percentChange(fromBytes, toBytes) {
  if (!fromBytes) return null;
  return Math.round(((fromBytes - toBytes) / fromBytes) * 10000) / 100;
}

// Decodes the source image and produces the resized "working" buffer that
// every quality/format encode runs against -- the same two-step shape as
// the source (`source` = the decoded <img>, `work` = the fitCanvas() result
// actually fed to canvas.toBlob()).
async function buildWorkingImage(buf, maxDimension) {
  // metadata() only parses the container header -- it does not decode pixels
  // -- so reading it with the limit disabled is safe and lets us reject an
  // oversized image with a message that names the actual dimensions and the
  // actual limit, instead of libvips' bare "Input image exceeds pixel limit".
  const originalMeta = await sharp(buf, { limitInputPixels: false }).metadata();
  byteLimits.assertPixelBudget(originalMeta.width, originalMeta.height, 'image_compress');

  // sharpLimits() then replaces libvips' own default limitInputPixels of
  // 268402689 (16383^2, ~1.07 GB decoded) with this container's budget on
  // every actual decode, as a backstop for anything the header understated.
  // Applied to every sharp() constructor here, not just the first -- each one
  // decodes independently.
  const workBuf = await sharp(buf, byteLimits.sharpLimits())
    .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
    .toBuffer();
  const workMeta = await sharp(workBuf, byteLimits.sharpLimits()).metadata();
  return {
    originalWidth: originalMeta.width || 0,
    originalHeight: originalMeta.height || 0,
    workBuf,
    workWidth: workMeta.width || 0,
    workHeight: workMeta.height || 0,
  };
}

async function compressImage(input) {
  const buf = byteLimits.decode(input.imageBase64);
  const format = FORMATS[input.format];
  const quality = input.quality;
  const maxDimension = input.maxDimension;

  const { originalWidth, originalHeight, workBuf, workWidth, workHeight } = await buildWorkingImage(buf, maxDimension);
  const compressedBuf = await format.encode(sharp(workBuf, byteLimits.sharpLimits()), quality).toBuffer();

  const originalBytes = buf.length;
  const compressedBytes = compressedBuf.length;

  return {
    buffer: compressedBuf,
    mimeType: format.mimeType,
    filename: `compressed.${format.ext}`,
    stats: {
      format: input.format,
      quality,
      original: { width: originalWidth, height: originalHeight, bytes: originalBytes },
      // The resized-but-not-yet-encoded stage -- the source never
      // serializes this on its own (it lives only as a <canvas>), so it has
      // dimensions but no independent byte size.
      working: { width: workWidth, height: workHeight, maxDimension },
      compressed: { width: workWidth, height: workHeight, bytes: compressedBytes },
      percentChange: percentChange(originalBytes, compressedBytes),
    },
  };
}

async function compressionCurve(input) {
  const buf = byteLimits.decode(input.imageBase64);
  const format = FORMATS[input.format];
  const maxDimension = input.maxDimension;

  // Belt and braces: the schema caps maxDimension at MAX_CURVE_MAX_DIMENSION,
  // but compressionCurve() is also called directly (tests, in-process
  // callers) where no zod parse has run.
  const effectiveMax = Math.min(maxDimension, MAX_CURVE_MAX_DIMENSION);
  const { originalWidth, originalHeight, workBuf, workWidth, workHeight } = await buildWorkingImage(buf, effectiveMax);
  const originalBytes = buf.length;

  const qualities = CURVE_QUALITIES.slice().sort((a, b) => a - b);
  // Encoded in fixed-size waves rather than all 14 at once -- see
  // CURVE_ENCODE_CONCURRENCY. Only the encoded LENGTH is kept per point (the
  // tool returns no image bytes), so each encoded buffer becomes collectable
  // as soon as its wave resolves instead of all 14 being retained at once.
  const points = [];
  for (let i = 0; i < qualities.length; i += CURVE_ENCODE_CONCURRENCY) {
    const wave = qualities.slice(i, i + CURVE_ENCODE_CONCURRENCY);
    const encodedWave = await Promise.all(
      wave.map(async (quality) => {
        const encoded = await format.encode(sharp(workBuf, byteLimits.sharpLimits()), quality).toBuffer();
        return { quality, bytes: encoded.length, percentChange: percentChange(originalBytes, encoded.length) };
      })
    );
    points.push(...encodedWave);
  }

  return {
    format: input.format,
    original: { width: originalWidth, height: originalHeight, bytes: originalBytes },
    // Reports the maxDimension actually applied, not the one requested, so a
    // caller can see when the curve's own tighter cap clamped their value.
    working: { width: workWidth, height: workHeight, maxDimension: effectiveMax },
    points,
  };
}

// The shape of the JSON in structuredContent. This tool also returns the
// generated file as a separate content block (inline image, embedded
// resource, or a resource_link to GET /files/:token, whichever
// utils/outputStore.js picks); the schema below covers the metadata half
// only, which is what the handler has always put in structuredContent.
const compressOutputSchema = {
  format: z.enum(['jpeg', 'webp', 'avif']).describe('Output format used.'),
  quality: z.number().int().describe('Quality level the image was encoded at.'),
  original: z
    .object({
      width: z.number().int().describe('Original width in px.'),
      height: z.number().int().describe('Original height in px.'),
      bytes: z.number().int().describe('Original file size in bytes.'),
    })
    .describe('The image as supplied.'),
  working: z
    .object({
      width: z.number().int().describe('Width after the downscale, in px.'),
      height: z.number().int().describe('Height after the downscale, in px.'),
      maxDimension: z.number().int().describe('The longest-side cap that was applied.'),
    })
    .describe('The image after being fitted to maxDimension but before re-encoding. Never an enlargement.'),
  compressed: z
    .object({
      width: z.number().int().describe('Output width in px.'),
      height: z.number().int().describe('Output height in px.'),
      bytes: z.number().int().describe('Output file size in bytes.'),
    })
    .describe('The returned file. Its bytes come back as a separate content block.'),
  percentChange: z
    .number()
    .describe('Size change against the original as a percentage; negative means smaller. Can be positive when re-encoding an already-optimised file.'),
};

// The shape of the JSON in structuredContent. Declared so an agent can
// read the result without parsing prose -- and, because the SDK validates
// every success against it, so a handler that quietly stops returning a
// field fails here instead of downstream.
const compressionCurveOutputSchema = {
  format: z.enum(['jpeg', 'webp', 'avif']).describe('Format every point was encoded in.'),
  original: z
    .object({
      width: z.number().int().describe('Original width in px.'),
      height: z.number().int().describe('Original height in px.'),
      bytes: z.number().int().describe('Original file size in bytes.'),
    })
    .describe('The image as supplied.'),
  working: z
    .object({
      width: z.number().int().describe('Width the curve was measured at, in px.'),
      height: z.number().int().describe('Height the curve was measured at, in px.'),
      maxDimension: z.number().int().describe('The longest-side cap that was applied before sampling.'),
    })
    .describe('The downscaled image every quality level was encoded from. The knee sits in the same place at either size, so this does not distort the curve.'),
  points: z
    .array(
      z.object({
        quality: z.number().int().describe('The quality level sampled.'),
        bytes: z.number().int().describe('Encoded size at that quality, in bytes.'),
        percentChange: z.number().describe('Size against the original as a percentage; negative means smaller.'),
      })
    )
    .describe("The 14 fixed sample points, ascending by quality. The 'knee' -- where size stops dropping much per quality point -- is what this tool exists to locate. No image bytes are returned."),
};

function register(server) {
  server.registerTool(
    'image_compress',
    {
      title: 'Compress an image (JPEG/WebP/AVIF)',
      description:
        "Downscales an image to fit within a maximum dimension (default 1600px on the longer side, never enlarges -- matching GO AI's browser compressor tool) and re-encodes it as JPEG, WebP or AVIF at a given quality (1-100 scale, default 75). Input is base64-encoded image bytes (any format sharp/libvips can decode: JPEG, PNG, WebP, AVIF, GIF, TIFF, ...), not a file path or URL, capped at this server's input size limit. Returns the compressed image bytes plus a stats object: original and compressed dimensions and byte sizes, and the percent size change (positive = smaller, negative = the re-encode came out bigger, which happens when compressing an already-small, already-compressed image). Re-encoding always strips EXIF/ICC metadata, exactly like the source tool.",
      annotations: toolAnnotations.PURE,
      outputSchema: compressOutputSchema,
      inputSchema: {
        imageBase64: z
          .string()
          .describe('Base64-encoded source image bytes (not a file path or URL).'),
        format: z
          .enum(['jpeg', 'webp', 'avif'])
          .optional()
          .default('webp')
          .describe(
            "Output format. 'webp' (default, matches the source's own default whenever WebP is available) is smaller than JPEG at equivalent visual quality; 'jpeg' is the safest choice for old viewers or print; 'avif' is smaller still but slower to encode."
          ),
        quality: z
          .number()
          .int()
          .min(MIN_QUALITY)
          .max(MAX_QUALITY)
          .optional()
          .default(DEFAULT_QUALITY)
          .describe(`Encoder quality, ${MIN_QUALITY}-${MAX_QUALITY} (matches the source's slider range). Defaults to ${DEFAULT_QUALITY}. 100 is the least-lossy setting the encoder offers, not truly lossless.`),
        maxDimension: z
          .number()
          .int()
          .min(1)
          .max(MAX_MAX_DIMENSION)
          .optional()
          .default(DEFAULT_MAX_DIMENSION)
          .describe(`Longer-side cap in pixels before encoding; the image is downscaled to fit inside this (aspect preserved) and is never enlarged. Defaults to ${DEFAULT_MAX_DIMENSION}, matching the source.`),
      },
    },
    async (args) => {
      try {
        const result = await compressImage(args);
        const bin = outputStore.emitBinaryOutput({ buffer: result.buffer, mimeType: result.mimeType, filename: result.filename });
        const meta = toolResult.ok(result.stats);
        return { content: [...meta.content, ...bin.content], structuredContent: meta.structuredContent };
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );

  server.registerTool(
    'image_compression_curve',
    {
      title: 'Image compression size-vs-quality curve',
      description:
        `Analysis-only tool (no image bytes returned): re-encodes an image at the same fixed 14 quality levels GO AI's browser compressor samples to draw its size-against-quality curve (5, 10, ..., through 100 -- see the qualities in each returned point), for JPEG, WebP or AVIF, and reports the resulting byte size and percent change at each level. The image is first downscaled to fit within maxDimension (default ${DEFAULT_MAX_DIMENSION}px on the longer side, never enlarged), exactly as the source's working canvas is, then every quality level is encoded one at a time. Because this repeats the encode 14 times, its maxDimension is capped at ${MAX_CURVE_MAX_DIMENSION}px -- lower than image_compress's ${MAX_MAX_DIMENSION}px -- which costs nothing in practice, since the knee of the curve is a property of the image's content and sits in the same place at either size. Use this to find that 'knee' (where size stops dropping much per quality point) for a specific image, or image_compress to actually get the compressed bytes at one chosen quality. Input is base64-encoded image bytes, not a file path or URL.`,
      annotations: toolAnnotations.PURE,
      outputSchema: compressionCurveOutputSchema,
      inputSchema: {
        imageBase64: z
          .string()
          .describe('Base64-encoded source image bytes (not a file path or URL).'),
        format: z
          .enum(['jpeg', 'webp', 'avif'])
          .optional()
          .default('webp')
          .describe("Format to sample the curve in. Defaults to 'webp', matching the source's own default."),
        maxDimension: z
          .number()
          .int()
          .min(1)
          .max(MAX_CURVE_MAX_DIMENSION)
          .optional()
          .default(DEFAULT_MAX_DIMENSION)
          .describe(`Longer-side cap in pixels before encoding, aspect preserved, never enlarged. Defaults to ${DEFAULT_MAX_DIMENSION}, matching the source. Capped at ${MAX_CURVE_MAX_DIMENSION} here (vs ${MAX_MAX_DIMENSION} for image_compress) because this tool runs the encode 14 times.`),
      },
    },
    async (args) => {
      try {
        const result = await compressionCurve(args);
        return toolResult.ok(result);
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );
}

module.exports = {
  register,
  toolCount: 2,
  compressImage,
  compressionCurve,
  CURVE_QUALITIES,
  DEFAULT_MAX_DIMENSION,
  DEFAULT_QUALITY,
  MAX_MAX_DIMENSION,
  MAX_CURVE_MAX_DIMENSION,
  CURVE_ENCODE_CONCURRENCY,
};
