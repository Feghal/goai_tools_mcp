'use strict';

const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const sharp = require('sharp');
const toolResult = require('../../utils/toolResult');
const byteLimits = require('../../utils/byteLimits');
const outputStore = require('../../utils/outputStore');
const zipUtil = require('../../utils/zip');

// Ported from nginx/sites/goai/tools/heic.html's inline <script>. That page
// decodes with a WebAssembly build of libheif in the browser and re-encodes
// via <canvas>.toBlob(); this server-side port decodes with the same
// vendored libheif build and re-encodes with sharp instead of a canvas.
const libheifFactory = require('../../utils/vendor/libheif/libheif.js');
const WASM_PATH = path.join(__dirname, '..', '..', 'utils', 'vendor', 'libheif', 'libheif.wasm');

// Built once per process and kept -- mirrors the source's "fetched on first
// conversion, then kept for the rest of the page's life" strategy. The
// vendored factory is synchronous and ready immediately in this Node build
// (confirmed by direct test), so there is no init-race to guard against.
let libheifModule = null;
function getLibheifModule() {
  if (!libheifModule) {
    const wasmBinary = fs.readFileSync(WASM_PATH);
    libheifModule = libheifFactory({ wasmBinary });
  }
  return libheifModule;
}

// Exact port of the source's sniff(): trust the magic bytes, never the
// filename extension or a claimed content-type, because iOS hands a web
// page a JPEG copy when a photo is picked from the Photos library -- the
// original HEIC is only reachable via Browse/Files. The "iso" branch (an
// ftyp box at offset 4, as any ISO-base-media file -- HEIC/HEIF/AVIF/etc.
// all start this way) is kept distinct from "other" for fidelity with the
// source even though both are treated identically below: anything that
// isn't sniffed as jpeg/png is simply handed to the HEIC decoder to find
// out whether it is one.
function sniff(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'iso'; // ...ftyp
  return 'other';
}

// Exact port of the source's outputName().
function outputName(name, mimeType) {
  const base = name.replace(/\.[^.]+$/, '');
  return base + (mimeType === 'image/png' ? '.png' : '.jpg');
}

// Decodes a HEIC/HEIF buffer to raw RGBA via the vendored libheif build.
// Returns null (not an error) when the container held no image, exactly
// like the source treating an empty decode() result as "not heic" rather
// than a hard failure. img.display() has already applied any EXIF-style
// rotation stored on the image by the time this returns -- that is the
// vendored build's own decode-time behavior (the source's FAQ says the
// same: "Rotation is stored as a property of the image ... and libheif
// applies it while decoding").
async function decodeHeicToRaw(buf) {
  const mod = getLibheifModule();
  const decoder = new mod.HeifDecoder();
  const images = decoder.decode(new Uint8Array(buf));
  if (!images || !images.length) return null;
  const img = images[0]; // one entry per image in the container; Live Photos
  // and similar multi-image HEICs are handled by converting only the first,
  // same as the source page.
  const width = img.get_width();
  const height = img.get_height();
  // The dimensions come straight out of the HEIC container's header and the
  // very next line allocates width * height * 4 bytes from them, with no
  // ceiling anywhere in libheif or in this port. A HEIC declaring 20000 x
  // 20000 is a small file that would ask for 1.6 GB here. Checked before the
  // allocation, and img.free()d on the way out so a rejected file does not
  // strand its libheif-side handle.
  try {
    byteLimits.assertPixelBudget(width, height, 'convert_heic_to_jpg_png');
  } catch (err) {
    if (typeof img.free === 'function') img.free();
    throw err;
  }
  const out = { data: new Uint8ClampedArray(width * height * 4), width, height };
  try {
    await new Promise((resolve, reject) => {
      img.display(out, (displayData) => (displayData ? resolve() : reject(new Error('HEIC display failed'))));
    });
  } finally {
    if (typeof img.free === 'function') img.free();
  }
  return { data: out.data, width, height };
}

function failedEntry(filename, inputByteCount, error) {
  return {
    filename,
    outputFilename: null,
    status: 'failed',
    mimeType: null,
    width: null,
    height: null,
    inputBytes: inputByteCount,
    outputBytes: null,
    error,
    buffer: null,
  };
}

// Converts one {filename, dataBase64} entry. Never throws for an expected
// input problem (oversized payload, corrupt/non-HEIC bytes, a decode that
// libheif or sharp rejects) -- those all come back as a 'failed' entry so
// one bad file in a batch doesn't sink the rest.
async function convertEntry(entry, format, quality) {
  let inputBuf;
  try {
    inputBuf = byteLimits.decode(entry.dataBase64);
  } catch (err) {
    return failedEntry(entry.filename, null, err.message);
  }

  const kind = sniff(inputBuf);
  if (kind === 'jpeg' || kind === 'png') {
    // Already the kind of file this tool produces -- passed through
    // unchanged rather than re-encoded, and reported as its own status so a
    // caller can tell "was already JPG/PNG" apart from "converted" or
    // "unreadable".
    const detectedMime = kind === 'jpeg' ? 'image/jpeg' : 'image/png';
    return {
      filename: entry.filename,
      outputFilename: entry.filename,
      status: 'already_converted',
      mimeType: detectedMime,
      width: null,
      height: null,
      inputBytes: inputBuf.length,
      outputBytes: inputBuf.length,
      buffer: inputBuf,
    };
  }

  let raw;
  try {
    raw = await decodeHeicToRaw(inputBuf);
  } catch (err) {
    return failedEntry(entry.filename, inputBuf.length, `could not be read as HEIC/HEIF: ${err.message}`);
  }
  if (!raw) return failedEntry(entry.filename, inputBuf.length, 'could not be read as HEIC/HEIF');

  let encoded;
  try {
    const pipeline = sharp(Buffer.from(raw.data), {
      raw: { width: raw.width, height: raw.height, channels: 4 },
      ...byteLimits.sharpLimits(),
    });
    encoded = format === 'image/png' ? await pipeline.png().toBuffer() : await pipeline.jpeg({ quality }).toBuffer();
  } catch (err) {
    return failedEntry(entry.filename, inputBuf.length, `decoded but could not be re-encoded: ${err.message}`);
  }

  return {
    filename: entry.filename,
    outputFilename: outputName(entry.filename, format),
    status: 'converted',
    mimeType: format,
    width: raw.width,
    height: raw.height,
    inputBytes: inputBuf.length,
    outputBytes: encoded.length,
    buffer: encoded,
  };
}

// Every converted/passed-through file's bytes are retained in `results` until
// the whole batch finishes (and copied again if bundleAsZip is set), so the
// batch needs a cap on OUTPUT size, not just on input size: a small HEIC can
// decode to a large bitmap and re-encode to a multi-megabyte JPEG, and the
// per-file input cap says nothing about that. 48 MB retained + 48 MB of ZIP
// stays inside this tool's share of the container budget.
const MAX_TOTAL_OUTPUT_BYTES = 48 * 1000 * 1000;

// One file at a time, not in parallel -- same reasoning as the source's own
// loop ("a batch of twelve-megapixel photos decoded together is what kills
// mobile Safari"): here it keeps one shared server process from stacking up
// several full-size raw RGBA buffers and libheif decodes at once.
async function convertHeicBatch(input) {
  const format = input.format || 'image/jpeg';
  const quality = input.quality == null ? 90 : input.quality;
  const bundleAsZip = !!input.bundleAsZip;

  // Aggregate input cap across the whole batch. byteLimits.decode() inside
  // convertEntry() only ever sees one file at a time, so on its own it would
  // let N files x MAX_INPUT_BYTES through. Estimated from the base64 string
  // lengths, before any decoding.
  let estimatedTotal = 0;
  for (const entry of input.files) {
    estimatedTotal += byteLimits.estimateDecodedSize(entry.dataBase64 || '');
  }
  if (estimatedTotal > byteLimits.MAX_TOTAL_INPUT_BYTES) {
    throw new byteLimits.InputTooLargeError(estimatedTotal, byteLimits.MAX_TOTAL_INPUT_BYTES);
  }

  const results = [];
  let totalOutputBytes = 0;
  for (const entry of input.files) {
    const result = await convertEntry(entry, format, quality);
    if (result.buffer) {
      totalOutputBytes += result.buffer.length;
      if (totalOutputBytes > MAX_TOTAL_OUTPUT_BYTES) {
        // Reported as a failed entry rather than thrown, so the files that
        // already converted are still returned -- the same "one bad file
        // doesn't sink the batch" contract convertEntry() already keeps.
        result.buffer = null;
        result.status = 'failed';
        result.outputBytes = null;
        result.error = `batch output passed the ${MAX_TOTAL_OUTPUT_BYTES}-byte per-call limit at this file; convert fewer files per call`;
      }
    }
    results.push(result);
  }
  return { results, format, quality, bundleAsZip };
}

const inputSchema = z.object({
  files: z
    .array(
      z.object({
        filename: z
          .string()
          .min(1)
          // Becomes the output name and a ZIP entry path; bounded for the
          // same reason as resize_images' `name`.
          .max(255)
          .describe('Original filename. Used only to derive the output name and to label report rows -- never trusted to identify the format.'),
        dataBase64: z
          .string()
          .min(1)
          .describe(
            `The file bytes, base64-encoded. Each decodes to at most ${byteLimits.MAX_INPUT_BYTES} bytes, and the whole batch to at most ${byteLimits.MAX_TOTAL_INPUT_BYTES} bytes combined.`
          ),
      })
    )
    .min(1)
    .max(50)
    .describe(
      `1 to 50 files, in the order results are reported. Mix HEIC/HEIF and already-JPEG/PNG files freely -- each is byte-sniffed on its own. The batch is additionally capped at ${byteLimits.MAX_TOTAL_INPUT_BYTES} bytes of combined decoded input, which is what binds in practice for real photos.`
    ),
  format: z
    .enum(['image/jpeg', 'image/png'])
    .default('image/jpeg')
    .describe('Output format for any real HEIC/HEIF input. Ignored for input already sniffed as JPEG or PNG, which is passed through unchanged rather than re-encoded.'),
  quality: z
    .number()
    .int()
    .min(50)
    .max(100)
    .default(90)
    .describe('JPEG quality, 50-100. Ignored when format is image/png (PNG is lossless).'),
  bundleAsZip: z
    .boolean()
    .default(false)
    .describe('When true and more than one file produced output bytes (converted or passed-through), bundle them into one converted.zip instead of returning each file as its own separate output.'),
});

function register(server) {
  server.registerTool(
    'convert_heic_to_jpg_png',
    {
      title: 'Convert HEIC/HEIF to JPG or PNG',
      description:
        'Converts iPhone HEIC/HEIF photos to JPEG or PNG, decoding with a WebAssembly build of libheif (LGPL-3.0) and re-encoding with sharp -- the same pipeline as GO AI\'s browser-based HEIC converter tool, run server-side. Accepts 1-50 files as {filename, dataBase64} (each up to ~30MB decoded); every file is byte-sniffed by its actual magic bytes, never by filename extension or claimed mime type, so an iPhone photo that iOS already delivered as a JPEG (picked from Photos rather than Files) is detected and reported as already_converted -- passed through unchanged, not re-encoded -- while real HEIC/HEIF input is decoded and re-encoded to the requested format (JPEG with a caller-set quality 50-100, or lossless PNG). Any orientation stored on the HEIC is applied automatically during decode, so output comes out right-side up. Metadata (EXIF: GPS, timestamp, camera) is not carried over, matching the source page. Each converted or passed-through file is returned individually (inline if small, as a download link if large), or bundled as one converted.zip when bundleAsZip is true and more than one file produced output; a file that fails to decode is reported with status failed and an error message rather than aborting the batch. The JSON report lists status, dimensions, and before/after byte sizes for every input file, in input order.',
      inputSchema,
    },
    async (args) => {
      try {
        const { results, format, bundleAsZip } = await convertHeicBatch(args);
        const produced = results.filter((r) => r.buffer);
        const report = results.map(({ buffer, ...rest }) => rest);
        const meta = toolResult.ok({ format, results: report });

        let binContent = [];
        if (produced.length > 1 && bundleAsZip) {
          const zipBuf = zipUtil.zip(produced.map((r) => ({ name: r.outputFilename, data: r.buffer })));
          const bin = outputStore.emitBinaryOutput({ buffer: zipBuf, mimeType: 'application/zip', filename: 'converted.zip' });
          binContent = bin.content;
        } else {
          for (const r of produced) {
            const bin = outputStore.emitBinaryOutput({ buffer: r.buffer, mimeType: r.mimeType, filename: r.outputFilename });
            binContent = binContent.concat(bin.content);
          }
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
  convertHeicBatch,
  convertEntry,
  sniff,
  outputName,
  inputSchema,
  MAX_TOTAL_OUTPUT_BYTES,
};
