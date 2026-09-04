'use strict';

const mod = require('../controllers/tools/exif-strip');
const { analyzeAndStripImage, jpegSegments, pngChunks, parseExif, register, toolCount } = mod;

// ---- byte-level fixture builders -----------------------------------------

// TIFF fields (inside an "II" stream) are little-endian; JPEG marker-segment
// length fields are big-endian per the JPEG spec (and per this parser's own
// `(bytes[i + 2] << 8) | bytes[i + 3]`) — two different helpers on purpose.
function u16le(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; }
function u32le(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b; }
function u16be(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v, 0); return b; }
function asciiZ(str) { return Buffer.concat([Buffer.from(str, 'ascii'), Buffer.from([0])]); }
function rational(num, den) { return Buffer.concat([u32le(num), u32le(den)]); }

// Builds one TIFF IFD (2-byte count + 12-byte entries + 4-byte next-IFD
// pointer + any "extra" data entries too big to fit inline), per the TIFF
// spec the source's readIFD/readValue expect.
function buildIFD(entries, ifdOffset) {
  const count = entries.length;
  const headerLen = 2 + count * 12 + 4;
  let extraOffset = ifdOffset + headerLen;
  const extraChunks = [];
  const entryBufs = entries.map((e) => {
    let valueB;
    if (e.data.length <= 4) {
      valueB = Buffer.alloc(4);
      e.data.copy(valueB, 0);
    } else {
      valueB = u32le(extraOffset);
      extraChunks.push(e.data);
      extraOffset += e.data.length;
      if (e.data.length % 2 === 1) { extraChunks.push(Buffer.from([0])); extraOffset += 1; }
    }
    return Buffer.concat([u16le(e.tag), u16le(e.type), u32le(e.count), valueB]);
  });
  return Buffer.concat([u16le(count), ...entryBufs, u32le(0), ...extraChunks]);
}

// Builds a little-endian TIFF stream (as it appears right after "Exif\0\0")
// with an IFD0 carrying Make/Model/Orientation plus a GPS sub-IFD.
function buildExifTiff({ make, model, orientation, gps } = {}) {
  const TIFF_HEADER_LEN = 8; // 'II' + 42 + offset-to-IFD0
  const ifd0Entries = [];
  if (make) ifd0Entries.push({ tag: 0x010f, type: 2, count: make.length + 1, data: asciiZ(make) });
  if (model) ifd0Entries.push({ tag: 0x0110, type: 2, count: model.length + 1, data: asciiZ(model) });
  if (orientation) ifd0Entries.push({ tag: 0x0112, type: 3, count: 1, data: u16le(orientation) });
  let gpsPointerIndex = -1;
  if (gps) {
    gpsPointerIndex = ifd0Entries.length;
    ifd0Entries.push({ tag: 0x8825, type: 4, count: 1, data: u32le(0) }); // placeholder, patched below
  }

  let ifd0 = buildIFD(ifd0Entries, TIFF_HEADER_LEN);
  let full;
  if (gps) {
    const gpsIfdOffset = TIFF_HEADER_LEN + ifd0.length;
    // Patch the GPS pointer's inline value now that we know the real offset.
    ifd0Entries[gpsPointerIndex].data = u32le(gpsIfdOffset);
    ifd0 = buildIFD(ifd0Entries, TIFF_HEADER_LEN); // same length, corrected inline value

    const gpsEntries = [
      { tag: 1, type: 2, count: 2, data: asciiZ(gps.latRef) },
      { tag: 2, type: 5, count: 3, data: Buffer.concat([rational(gps.lat[0], 1), rational(gps.lat[1], 1), rational(gps.lat[2], 1)]) },
      { tag: 3, type: 2, count: 2, data: asciiZ(gps.lonRef) },
      { tag: 4, type: 5, count: 3, data: Buffer.concat([rational(gps.lon[0], 1), rational(gps.lon[1], 1), rational(gps.lon[2], 1)]) },
      { tag: 6, type: 5, count: 1, data: rational(gps.altitude, 1) },
      { tag: 29, type: 2, count: gps.dateStamp.length + 1, data: asciiZ(gps.dateStamp) },
    ];
    const gpsIfd = buildIFD(gpsEntries, gpsIfdOffset);
    full = Buffer.concat([ifd0, gpsIfd]);
  } else {
    full = ifd0;
  }

  const header = Buffer.concat([Buffer.from([0x49, 0x49]), u16le(42), u32le(TIFF_HEADER_LEN)]);
  return Buffer.concat([header, full]);
}

function jpegSegment(marker, body) {
  const len = body.length + 2;
  return Buffer.concat([Buffer.from([0xff, marker]), u16be(len), body]);
}

function buildJpeg({ exif, xmp = true, iptc = true, comment = true, endWithEoi = true } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])]; // SOI
  if (exif !== false) {
    const tiff = buildExifTiff(exif || {});
    parts.push(jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff])));
  }
  if (xmp) {
    parts.push(jpegSegment(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0'), Buffer.from('<x:xmpmeta/>')])));
  }
  if (iptc) {
    parts.push(jpegSegment(0xed, Buffer.from([0x1c, 0x02, 0x00, 0x00, 0x00, 0x03, 0x41, 0x42, 0x43])));
  }
  if (comment) {
    parts.push(jpegSegment(0xfe, Buffer.from('hello world', 'ascii')));
  }
  // SOS + dummy entropy-coded scan data
  const scanBody = Buffer.from([0x00, 0x3f, 0x00]); // minimal SOS header bytes, content doesn't matter to this parser
  parts.push(jpegSegment(0xda, scanBody));
  parts.push(Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee])); // fake entropy-coded data
  if (endWithEoi) parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.from([0, 0, 0, 0])]); // fake CRC, unchecked by this parser
}

function buildPng({ withText = true } = {}) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = pngChunk('IHDR', Buffer.concat([u32le(1).reverse(), u32le(1).reverse(), Buffer.from([8, 6, 0, 0, 0])]));
  const parts = [sig, ihdr];
  if (withText) parts.push(pngChunk('tEXt', Buffer.from('Author\0Jane Doe', 'ascii')));
  parts.push(pngChunk('IDAT', Buffer.from([1, 2, 3, 4, 5])));
  parts.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------

describe('jpegSegments / pngChunks byte walk', () => {
  test('returns null for bytes that are neither JPEG nor PNG', () => {
    const bytes = Buffer.from('not an image at all, just text');
    expect(jpegSegments(bytes)).toBeNull();
    expect(pngChunks(bytes)).toBeNull();
  });

  test('walks a JPEG into its marker segments', () => {
    const bytes = buildJpeg();
    const segs = jpegSegments(bytes);
    expect(segs).not.toBeNull();
    const markers = segs.map((s) => s.marker.toString(16));
    expect(markers).toEqual(expect.arrayContaining(['e1', 'e1', 'ed', 'fe', 'da']));
    const scan = segs.find((s) => s.scan);
    expect(scan.end).toBe(bytes.length);
  });

  test('walks a PNG into its chunks, stopping at IEND', () => {
    const bytes = buildPng();
    const chunks = pngChunks(bytes);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'tEXt', 'IDAT', 'IEND']);
  });
});

describe('parseExif', () => {
  test('extracts IFD0 and GPS tags from a hand-built TIFF stream', () => {
    const tiff = buildExifTiff({
      make: 'Apple',
      model: 'iPhone 14',
      orientation: 6,
      gps: { latRef: 'N', lat: [40, 26, 46], lonRef: 'W', lon: [79, 58, 56], altitude: 100, dateStamp: '2024:01:15' },
    });
    const bytes = Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
    const parsed = parseExif(bytes, 0, bytes.length);
    expect(parsed).not.toBeNull();
    expect(parsed.ifd0[0x010f]).toBe('Apple');
    expect(parsed.ifd0[0x0110]).toBe('iPhone 14');
    expect(parsed.ifd0[0x0112][0]).toBe(6);
    expect(parsed.gps[1]).toBe('N');
    expect(parsed.gps[3]).toBe('W');
  });

  test('returns null for a non-TIFF byte order marker', () => {
    const bytes = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from([0x00, 0x00, 0, 42, 0, 0, 0, 8])]);
    expect(parseExif(bytes, 0, bytes.length)).toBeNull();
  });
});

describe('analyzeAndStripImage (JPEG)', () => {
  test('reports camera make/model, GPS, rotation warning, and removed segments', () => {
    const jpeg = buildJpeg({ exif: { make: 'Apple', model: 'iPhone 14', orientation: 6, gps: { latRef: 'N', lat: [40, 26, 46], lonRef: 'W', lon: [79, 58, 56], altitude: 100, dateStamp: '2024:01:15' } } });
    const result = analyzeAndStripImage({ image_base64: jpeg.toString('base64'), filename: 'photo.jpg' });

    expect(result.fail).toBeUndefined();
    const r = result.report;
    expect(r.recognized).toBe(true);
    expect(r.format).toBe('jpeg');
    expect(r.metadataFound).toBe(true);
    expect(r.make).toBe('Apple');
    expect(r.model).toBe('iPhone 14');
    expect(r.gps).toEqual({ latitude: 40.446111, longitude: -79.982222, altitudeMeters: 100, dateStamp: '2024:01:15' });
    expect(r.rotationWarning).toBe(true);
    expect(r.message).toMatch(/fields found/);
    expect(r.message).toMatch(/orientation tag/);

    // Two APP1 segments (Exif + XMP), one APP13 (IPTC), one COM.
    const labels = r.removedSegments.map((s) => s.label).sort();
    expect(labels).toEqual(['APP1', 'APP1', 'APP13', 'COM']);
    r.removedSegments.forEach((s) => expect(s.sizeBytes).toBeGreaterThan(0));

    expect(r.originalSizeBytes).toBe(jpeg.length);
    expect(r.cleanedSizeBytes).toBeLessThan(r.originalSizeBytes);
    expect(r.removedBytes).toBe(r.originalSizeBytes - r.cleanedSizeBytes);
    expect(r.verified).toBe(true);
    expect(r.cleanedImageIncluded).toBe(true);

    expect(result.cleanedBuffer).not.toBeNull();
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.filename).toBe('photo-clean.jpg');

    // The cleaned file must still start with SOI and contain no dropped markers.
    expect(result.cleanedBuffer[0]).toBe(0xff);
    expect(result.cleanedBuffer[1]).toBe(0xd8);
    const cleanedSegs = jpegSegments(result.cleanedBuffer);
    const cleanedMarkers = cleanedSegs.map((s) => s.marker);
    expect(cleanedMarkers).not.toContain(0xe1); // Exif/XMP gone
    expect(cleanedMarkers).not.toContain(0xed); // IPTC gone
    expect(cleanedMarkers).not.toContain(0xfe); // comment gone
  });

  test('adds a trailing EOI when the source scan lacks one', () => {
    const jpeg = buildJpeg({ exif: { make: 'X' }, xmp: false, iptc: false, comment: false, endWithEoi: false });
    const result = analyzeAndStripImage({ image_base64: jpeg.toString('base64'), filename: 'a.jpg' });
    expect(result.cleanedBuffer.slice(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });

  test('include_cleaned_image: false still reports byte counts but omits the binary', () => {
    const jpeg = buildJpeg({ exif: { make: 'Apple' } });
    const result = analyzeAndStripImage({ image_base64: jpeg.toString('base64'), include_cleaned_image: false });
    expect(result.report.cleanedSizeBytes).toEqual(expect.any(Number));
    expect(result.report.verified).toBe(true);
    expect(result.report.cleanedImageIncluded).toBe(false);
    expect(result.cleanedBuffer).toBeNull();
  });

  test('a JPEG with no metadata segments reports already-clean and no cleaned file', () => {
    const jpeg = buildJpeg({ exif: false, xmp: false, iptc: false, comment: false });
    const result = analyzeAndStripImage({ image_base64: jpeg.toString('base64') });
    expect(result.report.metadataFound).toBe(false);
    expect(result.report.fieldsFound).toBe(0);
    expect(result.report.message).toBe('No metadata found. This file is already clean.');
    expect(result.cleanedBuffer).toBeNull();
    expect(result.report.cleanedImageIncluded).toBe(false);
  });
});

describe('analyzeAndStripImage (PNG)', () => {
  test('drops tEXt and reports it as a removed chunk', () => {
    const png = buildPng({ withText: true });
    const result = analyzeAndStripImage({ image_base64: png.toString('base64'), filename: 'shot.png' });
    const r = result.report;
    expect(r.format).toBe('png');
    expect(r.metadataFound).toBe(true);
    expect(r.fields).toEqual([{ field: 'Text chunk', value: 'tEXt' }]);
    expect(r.removedSegments).toEqual([{ label: 'tEXt', sizeBytes: expect.any(Number) }]);
    expect(r.verified).toBe(true);
    expect(result.filename).toBe('shot-clean.png');
    expect(result.mimeType).toBe('image/png');

    const cleanedChunks = pngChunks(result.cleanedBuffer);
    expect(cleanedChunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
  });

  test('a PNG with no droppable chunks is already clean', () => {
    const png = buildPng({ withText: false });
    const result = analyzeAndStripImage({ image_base64: png.toString('base64') });
    expect(result.report.metadataFound).toBe(false);
    expect(result.cleanedBuffer).toBeNull();
  });
});

describe('unrecognized and malformed input', () => {
  test('bytes that are neither JPEG nor PNG fail with the source-page message', () => {
    const result = analyzeAndStripImage({ image_base64: Buffer.from('%PDF-1.4 not an image').toString('base64') });
    expect(result.fail).toBe('That file is not a JPEG or a PNG.');
  });

  test('a truncated/corrupt Exif segment is reported as unreadable, not thrown', () => {
    // A JPEG whose APP1 declares a segment length far larger than the bytes
    // actually present, so parseExif's DataView construction overruns the
    // buffer and throws — analyzeAndStripImage must catch that, not throw.
    const body = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0])]);
    const bogusLenSegment = Buffer.concat([Buffer.from([0xff, 0xe1]), u16le(0xfff0), body]);
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8]), bogusLenSegment]);
    const result = analyzeAndStripImage({ image_base64: bytes.toString('base64') });
    expect(result.fail).toBe('That file could not be read as an image.');
  });

  test('an oversized input is rejected before any parsing is attempted', () => {
    const hugeBase64 = 'A'.repeat(45 * 1000 * 1000);
    const result = analyzeAndStripImage({ image_base64: hugeBase64 });
    expect(result.fail).toMatch(/over the .* byte limit/);
  });
});

describe('register()', () => {
  test('registers exactly one tool named strip_image_metadata', async () => {
    const calls = [];
    const fakeServer = { registerTool: (...args) => calls.push(args) };
    register(fakeServer);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('strip_image_metadata');
    expect(toolCount).toBe(1);
  });

  test('the registered handler returns ok() JSON plus an inline image block', async () => {
    const calls = [];
    const fakeServer = { registerTool: (...args) => calls.push(args) };
    register(fakeServer);
    const handler = calls[0][2];
    const jpeg = buildJpeg({ exif: { make: 'Apple' } });
    const res = await handler({ image_base64: jpeg.toString('base64') });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent.metadataFound).toBe(true);
    const imageBlock = res.content.find((c) => c.type === 'image');
    expect(imageBlock).toBeDefined();
    expect(imageBlock.mimeType).toBe('image/jpeg');
  });

  test('the registered handler returns fail() for an unrecognized file', async () => {
    const calls = [];
    const fakeServer = { registerTool: (...args) => calls.push(args) };
    register(fakeServer);
    const handler = calls[0][2];
    const res = await handler({ image_base64: Buffer.from('nope').toString('base64') });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('That file is not a JPEG or a PNG.');
  });
});
