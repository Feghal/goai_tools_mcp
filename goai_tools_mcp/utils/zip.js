'use strict';

// Store-only ZIP writing, ported byte-for-byte from the browser tools'
// shared window.GOAI_ZIP (website_front/nginx/sites/goai/assets/zip.js),
// returning a Buffer instead of a Blob. PNG is already deflated, so a
// second compression pass costs time and saves nothing; storing entries
// verbatim keeps this to a CRC32 table and a few header structs instead of
// a compression library.

const CRC = (function buildTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(v) {
  return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
}
function u16(v) {
  return [v & 255, (v >>> 8) & 255];
}

// A ZIP entry name is a path the EXTRACTOR writes to, so a caller-supplied
// one is a zip-slip: an entry called "../../../app/server.js" makes a naive
// or auto-extracting client write outside the target directory. Sanitising
// here — at the one function every archive in this service passes through —
// rather than at each call site means no present or future caller can forget
// it, the same single-choke-point reasoning as outputStore.safeFilename().
// Unlike a flat download name, an entry legitimately nests output in preset
// subfolders (e.g. "social/card-1200x630.png", "android/mipmap-hdpi/x.png"),
// so the '/' separators are kept and every segment is cleaned on its own:
// drop any '.'/'..'/empty segment (no traversal survives) and reduce the rest
// to plain filename characters. The archive FORMAT is untouched — only the
// name string changes, and the local header and central directory are built
// from the same cleaned buffer, so offsets and CRCs stay consistent and real
// unzip still reads it.
function sanitizeEntryName(name) {
  const segments = String(name == null ? '' : name)
    .split(/[/\\]+/) // '\\' is a separator to a Windows extractor, so split on it too
    .map((seg) => seg.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, ''))
    .filter((seg) => seg && seg !== '.' && seg !== '..');
  return segments.length ? segments.join('/') : 'output';
}

// files: [{ name: 'a/b.png', data: Buffer|Uint8Array }, ...]
function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  files.forEach((f) => {
    const name = Buffer.from(sanitizeEntryName(f.name), 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const crc = crc32(data);
    const n = data.length;
    const local = Buffer.from([
      80, 75, 3, 4, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(n), ...u32(n), ...u16(name.length), ...u16(0),
    ]);
    chunks.push(local, name, data);
    central.push(
      Buffer.from([
        80, 75, 1, 2, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(crc), ...u32(n), ...u32(n), ...u16(name.length),
        ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
      ]),
      name
    );
    offset += local.length + name.length + n;
  });

  const cd = [];
  let cdLen = 0;
  for (let i = 0; i < central.length; i += 2) {
    cd.push(central[i], central[i + 1]);
    cdLen += central[i].length + central[i + 1].length;
  }

  const end = Buffer.from([
    80, 75, 5, 6, ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length), ...u32(cdLen), ...u32(offset), ...u16(0),
  ]);

  return Buffer.concat([...chunks, ...cd, end]);
}

module.exports = { zip, crc32, sanitizeEntryName };
