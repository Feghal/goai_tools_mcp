'use strict';

const { z } = require('zod');
const toolResult = require('../../utils/toolResult');
const byteLimits = require('../../utils/byteLimits');

// Ported from nginx/sites/goai/tools/strings-checker.html's inline <script>
// (the page's own scanner/diff logic, not the task hint, is ground truth --
// see the per-function notes below for the couple of places the hint
// guessed wrong about what the source actually does).

// ---------------------------------------------------------------------------
// Decoding: BOM sniff, then UTF-8 or UTF-16 LE/BE -- exact port of decode().
// ---------------------------------------------------------------------------

// The hint says to match "the source's own manual UTF-16 byte-swap fallback
// if TextDecoder('utf-16be') support is assumed unavailable there" -- but
// the source has no such fallback at all: it calls `new
// TextDecoder('utf-16be')` unconditionally and lets the browser handle it.
// The try/catch fallback below is added purely for this Node runtime (a
// full-ICU Node build, which is the default, supports 'utf-16be' natively
// and never takes this branch; a minimal-ICU build would otherwise throw
// where the source's assumed browser environment never would).
function decodeUtf16(bytes, endian) {
  if (endian === 'LE') return new TextDecoder('utf-16le').decode(bytes);
  try {
    return new TextDecoder('utf-16be').decode(bytes);
  } catch (err) {
    const swapped = Buffer.from(bytes); // copy -- do not mutate the caller's subarray
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const hi = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = hi;
    }
    return new TextDecoder('utf-16le').decode(swapped);
  }
}

// Byte-for-byte port of the source's decode(buffer): sniff a 2-byte UTF-16
// BOM (LE: FF FE, BE: FE FF) or a 3-byte UTF-8 BOM (EF BB BF), stripping it
// before decoding; anything else decodes as UTF-8 with no BOM to strip.
function decodeBuffer(buf) {
  const b = buf;
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return { text: decodeUtf16(b.subarray(2), 'LE'), enc: 'UTF-16 LE' };
  }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    return { text: decodeUtf16(b.subarray(2), 'BE'), enc: 'UTF-16 BE' };
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(b.subarray(3)), enc: 'UTF-8' };
  }
  return { text: new TextDecoder('utf-8').decode(b), enc: 'UTF-8' };
}

// ---------------------------------------------------------------------------
// Scanner: exact port of the source's hand-written parse(text) state machine.
// Operates on JS string indices (UTF-16 code units), same as the browser.
// ---------------------------------------------------------------------------

function parseStringsText(text) {
  const entries = [];
  const bad = [];
  let i = 0;
  let line = 1;
  const n = text.length;

  function readString() {
    let out = '';
    const start = line;
    i++; // opening quote
    while (i < n) {
      const c = text[i];
      if (c === '\\') {
        const e = text[i + 1];
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
        if (e === '\n') line++;
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        return out;
      }
      if (c === '\n') line++;
      out += c;
      i++;
    }
    bad.push({ line: start, text: 'unterminated string' });
    return null;
  }

  while (i < n) {
    const ch = text[i];
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') line++;
        i++;
      }
      i += 2; // unterminated block comment reports nothing, same as source
      continue;
    }
    if (ch === '"') {
      const at = line;
      const key = readString();
      if (key === null) break;
      while (i < n && /[ \t\r\n]/.test(text[i])) {
        if (text[i] === '\n') line++;
        i++;
      }
      if (text[i] !== '=') {
        bad.push({ line: at, text: 'expected = after the key' });
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
      i++;
      while (i < n && /[ \t\r\n]/.test(text[i])) {
        if (text[i] === '\n') line++;
        i++;
      }
      if (text[i] !== '"') {
        bad.push({ line: at, text: 'expected a quoted value' });
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
      const value = readString();
      if (value === null) break;
      while (i < n && /[ \t\r]/.test(text[i])) i++;
      if (text[i] !== ';') bad.push({ line: at, text: 'missing semicolon' });
      else i++;
      entries.push({ key, value, line: at });
      continue;
    }
    // Anything else at the top level is a line we cannot account for.
    const startLine = line;
    let junk = '';
    while (i < n && text[i] !== '\n') {
      junk += text[i];
      i++;
    }
    if (junk.trim()) bad.push({ line: startLine, text: junk.trim().slice(0, 60) });
  }

  return { entries, bad };
}

// Exact port of escapeValue() -- order matters (backslash first).
function escapeValue(v) {
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

// Exact port of normalise(): case-insensitive, trailing punctuation/space
// ignored, so "Done" and "Done." collide for the duplicate-value check.
function normaliseValue(v) {
  return v
    .toLowerCase()
    .replace(/[\s.!?:;,…]+$/, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Diff: exact port of report()'s comparison logic (minus DOM rendering).
// ---------------------------------------------------------------------------

// A real Localizable.strings file is a few hundred to a few thousand keys.
// 50,000 per file is an order of magnitude past the largest app anyone ships
// and keeps every per-file map, and the cross-file diff, bounded.
const MAX_ENTRIES_PER_FILE = 50000;

// One .strings file per locale; 40 covers every App Store locale.
const MAX_FILES = 40;

function checkStringsFiles(input) {
  const files = input.files;
  if (!Array.isArray(files) || files.length < 2) {
    throw new Error('at least two .strings files are required to compare');
  }

  // Aggregate decoded-input cap across every file, checked from the base64
  // lengths before anything is decoded -- byteLimits.decode() is a per-file
  // bound and this tool takes an unbounded-length array of files.
  const buffers = byteLimits.decodeBatch(files, (f) => f.content);

  const parsed = files.map((f, i) => {
    const d = decodeBuffer(buffers[i]);
    const out = parseStringsText(d.text);
    if (out.entries.length > MAX_ENTRIES_PER_FILE) {
      throw new Error(
        `"${f.name}" parsed to ${out.entries.length} entries, over the ${MAX_ENTRIES_PER_FILE}-entry per-file limit.`
      );
    }
    return { name: f.name, enc: d.enc, entries: out.entries, bad: out.bad };
  });

  // Source sorts the loaded files by name before populating the "compare
  // against" <select> and running report() -- this also decides display
  // order and which file wins ties when auto-picking the base.
  parsed.sort((a, b) => a.name.localeCompare(b.name));

  // Base selection: an explicit name that matches a loaded file wins; the
  // source's own auto-pick otherwise is the first (post-sort) file whose
  // name starts with "base." / "base-" / "base_" or "en." / "en-" / "en_"
  // (case-insensitive); failing that, the alphabetically-first file. An
  // explicit baseFile that matches nothing falls back the same way, exactly
  // as the source's `parsed.filter(...)[0] || parsed[0]` does.
  let base;
  if (input.baseFile) {
    base = parsed.find((p) => p.name === input.baseFile) || parsed[0];
  } else {
    const dev = parsed.find((p) => /^(base|en)[.\-_]/i.test(p.name));
    base = dev || parsed[0];
  }

  // Plain object maps, same as the source -- key lookups use `in`, which
  // (like the browser) checks the prototype chain too. A key literally
  // named "toString"/"constructor"/"hasOwnProperty"/etc. would read as
  // already-present via inherited properties in both environments; this is
  // an intentional byte-for-byte replication of the source's own behavior,
  // not a bug introduced here.
  const baseMap = {};
  base.entries.forEach((e) => {
    baseMap[e.key] = e.value;
  });
  const baseKeys = Object.keys(baseMap);

  const missing = [];
  const extra = [];
  const same = [];
  const dupes = [];
  const badRows = [];

  parsed.forEach((p) => {
    const map = {};
    p.entries.forEach((e) => {
      map[e.key] = e.value;
    });

    if (p !== base) {
      baseKeys.forEach((k) => {
        if (!(k in map)) missing.push([k, p.name, baseMap[k]]);
      });
      Object.keys(map).forEach((k) => {
        if (!(k in baseMap)) extra.push([k, p.name, map[k]]);
      });
      Object.keys(map).forEach((k) => {
        if (k in baseMap && map[k] === baseMap[k] && map[k].trim()) {
          same.push([k, p.name, map[k]]);
        }
      });
    }

    // The duplicate-value scan used to be quadratic: for EVERY duplicate
    // group it re-ran `p.entries.filter(e => normaliseValue(e.value) === v)`
    // over the whole entry list, recomputing normaliseValue (toLowerCase +
    // a regex + trim) for every entry, every time -- O(groups x entries).
    //
    // Measured on the old code with a file of N/2 distinct values each used
    // twice (so every group is a duplicate, the worst case): 131 KB of input
    // took 1057 ms, and the timings scaled cleanly as O(n^2) (2x the input
    // for 4x the time). Extrapolating that curve to a 4 MB file gives ~16
    // MINUTES of synchronously blocked event loop -- which is not just past
    // the 125 s Cloudflare ceiling, it stalls every other request in this
    // single-process server for the duration.
    //
    // The rescan only ever wanted one thing: the ORIGINAL (un-normalised)
    // value of the FIRST entry, in file order, whose normalised value is v.
    // The build pass below already visits entries in that order, so it can
    // record that value when it creates the group. Output is identical; the
    // work drops to a single O(entries) pass.
    const byValue = new Map();
    p.entries.forEach((e) => {
      const key = normaliseValue(e.value);
      if (!key) return;
      const group = byValue.get(key);
      if (group) group.keys.push(e.key);
      else byValue.set(key, { keys: [e.key], firstValue: e.value });
    });
    byValue.forEach((group) => {
      if (group.keys.length > 1) {
        dupes.push([p.name, group.firstValue, group.keys.join(', ')]);
      }
    });

    p.bad.forEach((b) => badRows.push([p.name, b.line, b.text]));
  });

  // Matches the source's own stat exactly: `issues = missing.length +
  // dupes.length + same.length + badRows.length` -- extra keys are counted
  // and reported, but deliberately NOT added to the issue total.
  const issueCount = missing.length + dupes.length + same.length + badRows.length;

  const missingKeysStrings = missing.map((r) => `"${escapeValue(r[0])}" = "${escapeValue(r[2])}";`).join('\n');

  return {
    baseFile: base.name,
    fileCount: parsed.length,
    keysInBase: baseKeys.length,
    issueCount,
    missingKeys: missing.map(([key, file, baseValue]) => ({ key, file, baseValue })),
    extraKeys: extra.map(([key, file, value]) => ({ key, file, value })),
    duplicateValues: dupes.map(([file, value, keys]) => ({ file, value, keys })),
    identicalToBase: same.map(([key, file, value]) => ({ key, file, value })),
    badLines: badRows.map(([file, line, text]) => ({ file, line, text })),
    missingKeysStrings,
    files: parsed.map((p) => ({
      name: p.name,
      encoding: p.enc,
      keyCount: p.entries.length,
      badLineCount: p.bad.length,
    })),
  };
}

function register(server) {
  server.registerTool(
    'check_strings_files',
    {
      title: 'iOS .strings localization checker',
      description:
        'Compares two or more iOS Localizable.strings files (sent as base64-encoded raw file bytes, not text) against a base file and reports keys missing from each other file, keys present in another file but not the base ("extra", reported but not counted toward the issue total), values byte-identical to the base (often untranslated, sometimes intentionally so), duplicate values under different keys within the same file (case- and trailing-punctuation-insensitive), and lines that fail to parse with their line number. Sniffs a UTF-8 or UTF-16 LE/BE byte-order mark per file so files exported by Xcode in UTF-16 decode correctly instead of producing a wall of parse errors. Does not support the newer .xcstrings JSON catalogue format, and does not check plural rules or placeholder (%@/%d) consistency between files -- it is a pure key/value diff.',
      inputSchema: {
        files: z
          .array(
            z.object({
              name: z
                .string()
                .min(1)
                .max(255)
                .describe('File name, e.g. "en.lproj/Localizable.strings" -- shown in the report and used to auto-select the base file.'),
              content: z
                .string()
                .min(1)
                .describe(
                  "Base64-encoded RAW BYTES of the file (not its decoded text) -- send it exactly as read from disk so BOM sniffing and UTF-16 decoding work the same way the browser tool's FileReader does."
                ),
            })
          )
          .min(2)
          // The cross-file diff is O(files x keysInBase), and every non-base
          // file contributes rows to missing/extra/identicalToBase. An app
          // ships one .strings per locale; 40 covers every locale Apple
          // offers with room to spare.
          .max(MAX_FILES)
          .describe(`Two to ${MAX_FILES} .strings files to compare against each other.`),
        baseFile: z
          .string()
          .max(255)
          .optional()
          .describe(
            'Exact name of one of files[] to treat as the base ("compare against") file. When omitted, auto-selects the first file (after sorting all names alphabetically) whose name starts with "base." / "base-" / "base_" or "en." / "en-" / "en_" (case-insensitive), falling back to the alphabetically-first file if none match. A name that does not match any loaded file falls back the same way.'
          ),
      },
    },
    async (args) => {
      try {
        const result = checkStringsFiles(args);
        return toolResult.ok(result);
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );
}

module.exports = {
  register,
  toolCount: 1,
  checkStringsFiles,
  parseStringsText,
  decodeBuffer,
  normaliseValue,
  escapeValue,
  MAX_ENTRIES_PER_FILE,
  MAX_FILES,
};
