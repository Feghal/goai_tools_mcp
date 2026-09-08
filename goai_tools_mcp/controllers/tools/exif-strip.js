'use strict';

// Ported byte-for-byte from the client-side parser in
// nginx/sites/goai/tools/exif.html (website_front repo) — a JPEG marker walk
// and a PNG chunk walk, no library, no re-encode, no pixel decode. Reads:
//   JPEG: EXIF (APP1 "Exif\0"), XMP (APP1 "http..."), IPTC/Photoshop (APP13),
//         comments (COM). APP0 (JFIF) and APP2 (ICC) are left alone — they
//         describe how to render the picture, not who took it.
//   PNG:  tEXt/iTXt/zTXt/eXIf/tIME chunks are dropped; every other chunk
//         (IHDR/PLTE/IDAT/IEND/...) is copied unchanged.
// The cleaned file is built by concatenating every *kept* segment/chunk
// verbatim, then the source's own self-check is replicated: the picture
// data (the JPEG scan, or the PNG IDAT chunks) in the output is compared
// byte-by-byte against the input, and a cleaned file is only handed back
// if that check passes.

const { z } = require('zod');
const toolResult = require('../../utils/toolResult');
const toolAnnotations = require('../../utils/toolAnnotations');
const byteLimits = require('../../utils/byteLimits');
const outputStore = require('../../utils/outputStore');

// ---- TIFF/EXIF reader (verbatim port of TYPE_SIZE / reader / readValue /
// readIFD / ratio / dms / parseExif from the source page) -----------------

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function reader(view, base, little) {
  return {
    u16: (o) => view.getUint16(base + o, little),
    u32: (o) => view.getUint32(base + o, little),
    i32: (o) => view.getInt32(base + o, little),
    u8: (o) => view.getUint8(base + o),
  };
}

function readValue(r, type, count, offset) {
  let out = [];
  let i;
  if (type === 2) {
    let s = '';
    for (i = 0; i < count; i++) {
      const c = r.u8(offset + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }
  for (i = 0; i < count && i < 24; i++) {
    if (type === 1 || type === 7) out.push(r.u8(offset + i));
    else if (type === 3) out.push(r.u16(offset + i * 2));
    else if (type === 4) out.push(r.u32(offset + i * 4));
    else if (type === 9) out.push(r.i32(offset + i * 4));
    else if (type === 5) out.push([r.u32(offset + i * 8), r.u32(offset + i * 8 + 4)]);
    else if (type === 10) out.push([r.i32(offset + i * 8), r.i32(offset + i * 8 + 4)]);
    // Types 6/8/11/12 (SBYTE/SSHORT/FLOAT/DOUBLE) have no branch in the
    // source either — they simply contribute nothing to `out`.
  }
  return out;
}

function readIFD(r, offset, into, limit) {
  if (offset <= 0 || offset > limit - 2) return 0;
  const count = r.u16(offset);
  let i;
  if (count > 512) return 0;
  for (i = 0; i < count; i++) {
    const e = offset + 2 + i * 12;
    if (e + 12 > limit) break;
    const tag = r.u16(e);
    const type = r.u16(e + 2);
    const n = r.u32(e + 4);
    const size = (TYPE_SIZE[type] || 0) * n;
    if (!size) continue;
    const at = size > 4 ? r.u32(e + 8) : e + 8;
    if (at + size > limit) continue;
    into[tag] = readValue(r, type, n, at);
  }
  // Read unconditionally, same as the source — a truncated/malformed IFD
  // can make this throw, which the caller's try/catch turns into "broken".
  return r.u32(offset + 2 + count * 12);
}

function ratio(pair) {
  if (!pair || !pair.length) return null;
  return pair[1] ? pair[0] / pair[1] : null;
}

function dms(list, ref) {
  if (!list || list.length < 3) return null;
  const d = ratio(list[0]);
  const m = ratio(list[1]);
  const s = ratio(list[2]);
  if (d === null || m === null || s === null) return null;
  const v = d + m / 60 + s / 3600;
  return ref === 'S' || ref === 'W' ? -v : v;
}

function parseExif(bytes, start, length) {
  // "Exif\0\0" then a complete little- or big-endian TIFF stream.
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, length);
  const tiff = 6;
  const order = view.getUint16(tiff, false);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const little = order === 0x4949;
  const r = reader(view, tiff, little);
  if (r.u16(2) !== 42) return null;
  const ifd0 = {};
  const exif = {};
  const gps = {};
  const next = readIFD(r, r.u32(4), ifd0, length - tiff);
  // Matches the source exactly: a second (thumbnail) IFD, if present, is
  // merged into the same ifd0 object rather than kept separate.
  if (next) readIFD(r, next, ifd0, length - tiff);
  if (ifd0[0x8769]) readIFD(r, ifd0[0x8769][0], exif, length - tiff);
  if (ifd0[0x8825]) readIFD(r, ifd0[0x8825][0], gps, length - tiff);
  return { ifd0, exif, gps };
}

// ---- JPEG segment walk ----------------------------------------------------
// A real JPEG has a few dozen segments and a PNG a few dozen chunks. Both
// walks below push one descriptor object per segment/chunk found, and a
// crafted file can be almost entirely made of minimum-size ones: a JPEG
// segment costs 4 bytes (a 2-byte marker plus a length of 2), and a PNG chunk
// 12 bytes, so a 4 MB input can yield ~1,000,000 JPEG segment objects (~100 MB
// of descriptors) before any of the real work starts. Both walks also feed
// `keep`/`dropped`, and `removedSegments` is serialized into the response.
//
// 8192 is two orders of magnitude past any real file and makes the walk's
// cost proportional to the file rather than to how finely it is subdivided.
const MAX_SEGMENTS = 8192;

function jpegSegments(bytes) {
  const segs = [];
  let i = 2;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  while (i < bytes.length - 1) {
    // Bailing out to null (rather than truncating the list) makes the caller
    // treat the file as unrecognized, which is the honest answer: a file this
    // finely subdivided is not one this tool can safely claim to have cleaned.
    if (segs.length >= MAX_SEGMENTS) return null;
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xda) { segs.push({ marker, start: i, end: bytes.length, scan: true }); break; }
    if (marker === 0xd9) break;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) break;
    segs.push({ marker, start: i, end: i + 2 + len, body: i + 4, length: len - 2 });
    i += 2 + len;
  }
  return segs;
}

function ascii(bytes, at, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[at + i]);
  return s;
}

function isMetadata(bytes, seg) {
  if (seg.marker === 0xfe) return 'comment'; // COM
  if (seg.marker === 0xed) return 'iptc'; // APP13
  if (seg.marker === 0xe1) {
    const tag = ascii(bytes, seg.body, 5);
    if (tag === 'Exif\0') return 'exif';
    if (ascii(bytes, seg.body, 4) === 'http') return 'xmp';
    return 'exif'; // any other APP1 payload is treated conservatively as identifying data
  }
  return null;
}

// ---- PNG chunk walk ---------------------------------------------------
const PNG_DROP = { tEXt: 1, iTXt: 1, zTXt: 1, eXIf: 1, tIME: 1 };
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function pngChunks(bytes) {
  let i;
  for (i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return null;
  const out = [];
  let at = 8;
  while (at + 8 <= bytes.length) {
    if (out.length >= MAX_SEGMENTS) return null; // see MAX_SEGMENTS
    const len = ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
    const type = ascii(bytes, at + 4, 4);
    out.push({ type, start: at, end: at + 12 + len, body: at + 8, length: len });
    if (type === 'IEND') break;
    at += 12 + len;
  }
  return out;
}

// Human labels straight from the source page's (English) exif-strings JSON
// block, reused verbatim so the field list here reads the same as the tool
// page a person would see.
const LABELS = {
  make: 'Camera make', model: 'Camera model', lens: 'Lens', software: 'Software',
  original: 'Taken on', datetime: 'Date and time', bodySerial: 'Camera serial number',
  lensSerial: 'Lens serial number', artist: 'Author', copyright: 'Copyright',
  orientation: 'Orientation', exposure: 'Exposure', aperture: 'Aperture', iso: 'ISO',
  focal: 'Focal length', gpsLat: 'Latitude', gpsLon: 'Longitude', gpsAltitude: 'Altitude',
  gpsDate: 'Location recorded', xmp: 'XMP block', iptc: 'IPTC block', comment: 'Comment',
  pngText: 'Text chunk',
};
const PRESENT = 'present';

function fields(parsed) {
  const rows = [];
  const g = parsed.gps;
  const e = parsed.exif;
  const z = parsed.ifd0;
  function push(key, value) {
    if (value === null || value === undefined || value === '') return;
    rows.push({ field: LABELS[key] || key, value: String(value) });
  }
  push('make', z[0x010f]);
  push('model', z[0x0110]);
  push('lens', e[0xa434]);
  push('software', z[0x0131]);
  push('original', e[0x9003] || z[0x0132]);
  push('datetime', z[0x0132] && z[0x0132] !== e[0x9003] ? z[0x0132] : null);
  push('bodySerial', e[0xa431]);
  push('lensSerial', e[0xa435]);
  push('artist', z[0x013b]);
  push('copyright', z[0x8298]);
  if (z[0x0112] && z[0x0112][0] > 1) push('orientation', z[0x0112][0]);
  const exp = ratio(e[0x829a] && e[0x829a][0]);
  if (exp) push('exposure', exp >= 1 ? exp + ' s' : '1/' + Math.round(1 / exp) + ' s');
  const fn = ratio(e[0x829d] && e[0x829d][0]);
  if (fn) push('aperture', 'f/' + Math.round(fn * 10) / 10);
  if (e[0x8827]) push('iso', e[0x8827][0]);
  const fl = ratio(e[0x920a] && e[0x920a][0]);
  if (fl) push('focal', Math.round(fl) + ' mm');
  const lat = dms(g[2], g[1]);
  const lon = dms(g[4], g[3]);
  if (lat !== null) push('gpsLat', lat.toFixed(6));
  if (lon !== null) push('gpsLon', lon.toFixed(6));
  const alt = ratio(g[6] && g[6][0]);
  if (alt) push('gpsAltitude', Math.round(alt) + ' m');
  if (g[29]) push('gpsDate', g[29]);
  return {
    rows,
    make: z[0x010f] || null,
    model: z[0x0110] || null,
    lat,
    lon,
    alt: alt || null,
    gpsDate: g[29] || null,
    rotated: !!(z[0x0112] && z[0x0112][0] > 1),
  };
}

function segmentLabel(isPng, seg) {
  if (isPng) return seg.type;
  if (seg.marker === 0xfe) return 'COM';
  if (seg.marker >= 0xe0 && seg.marker <= 0xef) return 'APP' + (seg.marker - 0xe0);
  return 'FF' + seg.marker.toString(16).toUpperCase();
}

// Analyzes `bytes` and, when metadata was found, builds the cleaned file —
// this is the direct port of the source's `show()` function, minus all DOM
// work, split into a JSON report plus (optionally) the cleaned Buffer.
// Returns { unrecognized: true } when the bytes are neither a JPEG nor a PNG.
function stripMetadata(bytes, filename, includeCleanedImage) {
  const name = filename || 'image';
  const segs = jpegSegments(bytes);
  let isPng = false;
  let rows = [];
  let info = null;
  const keep = [];
  const dropped = [];

  if (segs) {
    segs.forEach((seg) => {
      const kind = seg.scan ? null : isMetadata(bytes, seg);
      if (kind) {
        dropped.push(seg);
        if (kind === 'exif') {
          const parsed = parseExif(bytes, seg.body, seg.length);
          if (parsed) info = fields(parsed);
        } else {
          rows.push({ field: LABELS[kind] || kind, value: PRESENT });
        }
      } else {
        keep.push(seg);
      }
    });
  } else {
    const chunks = pngChunks(bytes);
    if (!chunks) return { unrecognized: true };
    isPng = true;
    chunks.forEach((c) => {
      if (PNG_DROP[c.type]) {
        dropped.push(c);
        rows.push({ field: LABELS.pngText, value: c.type });
      } else {
        keep.push(c);
      }
    });
  }
  if (info) rows = info.rows.concat(rows);

  let gps = null;
  if (info && info.lat !== null && info.lon !== null) {
    gps = {
      latitude: Number(info.lat.toFixed(6)),
      longitude: Number(info.lon.toFixed(6)),
      altitudeMeters: info.alt !== null ? Math.round(info.alt) : null,
      dateStamp: info.gpsDate,
    };
  }

  const report = {
    recognized: true,
    format: isPng ? 'png' : 'jpeg',
    metadataFound: dropped.length > 0,
    fieldsFound: rows.length,
    fields: rows,
    make: info ? info.make : null,
    model: info ? info.model : null,
    gps,
    rotationWarning: !!(info && info.rotated),
    removedSegments: dropped.map((s) => ({ label: segmentLabel(isPng, s), sizeBytes: s.end - s.start })),
    removedSegmentCount: dropped.length,
    originalSizeBytes: bytes.length,
    cleanedSizeBytes: null,
    removedBytes: null,
    verified: null,
    verifiedBytes: null,
    cleanedImageIncluded: false,
    message: dropped.length
      ? `${rows.length} fields found, including the ones below.`
      : 'No metadata found. This file is already clean.',
  };

  if (!dropped.length) {
    return { report, cleanedBuffer: null };
  }

  // ---- Build the cleaned file by copying every kept segment verbatim ----
  const head = isPng ? 8 : 2;
  // The scan segment is copied to the end of the file, which normally
  // already carries EOI; only add one when the source lacks it.
  const needsEoi = !isPng && !(bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9);
  let size = head + (needsEoi ? 2 : 0);
  keep.forEach((s) => { size += s.end - s.start; });
  const out = Buffer.alloc(size);
  let at = 0;
  let i;
  for (i = 0; i < head; i++) out[at++] = bytes[i];
  keep.forEach((s) => {
    bytes.copy(out, at, s.start, s.end); // clamps like the source's subarray/.set if s.end runs past bytes.length
    at += s.end - s.start;
  });
  if (needsEoi) { out[at++] = 0xff; out[at++] = 0xd9; }

  // The scan (JPEG) or the IDAT chunks (PNG) are the picture itself. Walk
  // the output alongside the input and compare the picture data byte by
  // byte, so the "unchanged" claim is checked rather than asserted.
  const scan = isPng ? keep.filter((c) => c.type === 'IDAT') : keep.filter((s) => s.scan);
  let offset = head;
  let verified = true;
  let checked = 0;
  keep.forEach((s) => {
    const len = s.end - s.start;
    if (scan.indexOf(s) >= 0) {
      for (i = 0; i < len; i++) {
        if (out[offset + i] !== bytes[s.start + i]) { verified = false; break; }
      }
      checked += len;
    }
    offset += len;
  });

  report.cleanedSizeBytes = out.length;
  report.removedBytes = bytes.length - out.length;
  report.verified = verified;
  report.verifiedBytes = checked;
  if (!verified) {
    report.message += ' The image data could not be verified as unchanged, so nothing was removed.';
  }
  if (report.rotationWarning) {
    report.message += ' This photo relies on an orientation tag. Once stripped it may appear rotated.';
  }

  const cleanedBuffer = verified ? out : null;
  report.cleanedImageIncluded = !!(cleanedBuffer && includeCleanedImage);

  return {
    report,
    cleanedBuffer: report.cleanedImageIncluded ? cleanedBuffer : null,
    filename: name.replace(/(\.[a-z0-9]+)$/i, '') + '-clean' + (isPng ? '.png' : '.jpg'),
    mimeType: isPng ? 'image/png' : 'image/jpeg',
  };
}

// Decodes the input, runs stripMetadata, and turns every expected failure
// (oversized input, unrecognized format, an exception while walking a
// malformed file — the source's own try/catch around show() catches this
// case and reports "broken") into { fail: message } instead of throwing.
function analyzeAndStripImage({ image_base64: imageBase64, filename, include_cleaned_image: includeCleanedImage }) {
  let bytes;
  try {
    bytes = byteLimits.decode(imageBase64);
  } catch (err) {
    return { fail: err.message };
  }
  const wantCleaned = includeCleanedImage !== false;
  let result;
  try {
    result = stripMetadata(bytes, filename, wantCleaned);
  } catch (err) {
    return { fail: 'That file could not be read as an image.' };
  }
  if (result.unrecognized) {
    return { fail: 'That file is not a JPEG or a PNG.' };
  }
  return result;
}

// The shape of the JSON in structuredContent. This tool also returns the
// generated file as a separate content block (inline image, embedded
// resource, or a resource_link to GET /files/:token, whichever
// utils/outputStore.js picks); the schema below covers the metadata half
// only, which is what the handler has always put in structuredContent.
const exifStripOutputSchema = {
  recognized: z
    .literal(true)
    .describe('Always true here. A file that is neither a JPEG nor a PNG comes back as an error result instead, not as recognized:false.'),
  format: z.enum(['jpeg', 'png']).describe('Which of the two supported formats the file was read as.'),
  metadataFound: z.boolean().describe('Whether any strippable metadata was present at all.'),
  fieldsFound: z.number().int().describe('How many individual metadata fields were read out.'),
  fields: z
    .array(
      z.object({
        field: z.string().describe('Human-readable field name, e.g. Camera make, Latitude, XMP block.'),
        value: z.string().describe('The value as found, stringified.'),
      })
    )
    .describe('Every metadata field read from the file -- this is the disclosure the caller is usually checking for.'),
  make: z.string().nullable().describe('Camera make, when EXIF carried one.'),
  model: z.string().nullable().describe('Camera model, when EXIF carried one.'),
  gps: z
    .object({
      latitude: z.number().describe('Latitude in decimal degrees, to 6 places.'),
      longitude: z.number().describe('Longitude in decimal degrees, to 6 places.'),
      altitudeMeters: z.number().nullable().describe('Altitude in metres, when recorded.'),
      dateStamp: z.string().nullable().describe('GPS date stamp, when recorded.'),
    })
    .nullable()
    .describe('Embedded location, or null when the file carried none. The single most sensitive thing in a photo, so it is surfaced on its own rather than only inside fields.'),
  rotationWarning: z
    .boolean()
    .describe('True when an EXIF Orientation tag was removed, which can make the cleaned image appear rotated in viewers that relied on it.'),
  removedSegments: z
    .array(
      z.object({
        label: z.string().describe('Which segment or chunk was removed, e.g. EXIF, XMP, a PNG tEXt chunk.'),
        sizeBytes: z.number().int().describe('Its size in bytes.'),
      })
    )
    .describe('Each metadata segment or chunk that was stripped, with its size.'),
  removedSegmentCount: z.number().int().describe('Number of segments/chunks removed.'),
  originalSizeBytes: z.number().int().describe('Size of the supplied file in bytes.'),
  cleanedSizeBytes: z.number().int().nullable().describe('Size of the cleaned file, or null when no cleaned image was produced.'),
  removedBytes: z.number().int().nullable().describe('Bytes saved by stripping, or null when no cleaned image was produced.'),
  verified: z
    .boolean()
    .nullable()
    .describe('Result of the byte-for-byte check that the retained image data is unchanged. Null when no cleaning was attempted; false means the check failed and no cleaned file was returned.'),
  verifiedBytes: z.number().int().nullable().describe('How many bytes that check compared. Null when no cleaning was attempted.'),
  cleanedImageIncluded: z
    .boolean()
    .describe('Whether a cleaned file accompanies this report as a content block. False when include_cleaned_image was off, when there was nothing to strip, or when verification failed.'),
  message: z.string().describe('Plain-language summary, including why no cleaned file was returned when that is the case.'),
};

function register(server) {
  server.registerTool(
    'strip_image_metadata',
    {
      title: 'Strip image metadata (EXIF/GPS/XMP/IPTC/PNG text)',
      description:
        "Reads a JPEG or PNG's hidden metadata (JPEG: EXIF — camera make/model, lens, body/lens serial numbers, capture date, GPS coordinates and altitude — plus XMP, IPTC/Photoshop resources and comment segments; PNG: tEXt/iTXt/zTXt/eXIf/tIME chunks) and returns a structured report of exactly what it found, including the size of every metadata segment/chunk that was removed. Optionally (include_cleaned_image, default true) also returns the same image with those segments/chunks stripped at the byte level: no re-encoding and no pixel decode, so the compressed image data, ICC profile, and JFIF/PNG structure are copied unchanged. It runs a byte-for-byte self-check that the retained image data is actually unchanged before handing back a cleaned file — if that check fails, no cleaned file is returned even though the report is still produced. Only JPEG and PNG signatures are recognized (not TIFF or other formats); stripping a photo's EXIF Orientation tag can make it appear rotated, which the report flags.",
      annotations: toolAnnotations.PURE,
      outputSchema: exifStripOutputSchema,
      inputSchema: {
        image_base64: z.string().min(1).describe('Base64-encoded bytes of the JPEG or PNG file to inspect.'),
        filename: z
          .string()
          // Becomes the returned cleaned file's name.
          .max(255)
          .optional()
          .describe('Original filename, used only to name the returned cleaned file (defaults to "image"). Format detection is by content signature, not by this name or extension.'),
        include_cleaned_image: z
          .boolean()
          .optional()
          .default(true)
          .describe('When true (default), also return the metadata-stripped image bytes alongside the report. Set to false to get only the report.'),
      },
    },
    async (args) => {
      try {
        const result = analyzeAndStripImage(args);
        if (result.fail) return toolResult.fail(result.fail);
        const metaResult = toolResult.ok(result.report);
        if (result.cleanedBuffer) {
          const binResult = outputStore.emitBinaryOutput({
            buffer: result.cleanedBuffer,
            mimeType: result.mimeType,
            filename: result.filename,
          });
          return { content: [...metaResult.content, ...binResult.content], structuredContent: metaResult.structuredContent };
        }
        return metaResult;
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );
}

module.exports = {
  register,
  toolCount: 1,
  analyzeAndStripImage,
  stripMetadata,
  jpegSegments,
  pngChunks,
  parseExif,
  MAX_SEGMENTS,
};
