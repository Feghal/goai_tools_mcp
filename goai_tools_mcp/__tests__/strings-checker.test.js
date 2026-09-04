'use strict';

const {
  checkStringsFiles,
  parseStringsText,
  decodeBuffer,
  normaliseValue,
  escapeValue,
} = require('../controllers/tools/strings-checker');

function utf8B64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}
function utf8BomB64(str) {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(str, 'utf8')]).toString('base64');
}
function utf16LeBomB64(str) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(str, 'utf16le')]).toString('base64');
}
function utf16BeBytes(str) {
  const le = Buffer.from(str, 'utf16le');
  const be = Buffer.from(le);
  for (let i = 0; i + 1 < be.length; i += 2) {
    const hi = be[i];
    be[i] = be[i + 1];
    be[i + 1] = hi;
  }
  return be;
}
function utf16BeBomB64(str) {
  return Buffer.concat([Buffer.from([0xfe, 0xff]), utf16BeBytes(str)]).toString('base64');
}

describe('decodeBuffer', () => {
  const sample = '"k" = "café — 日本語";';

  test('no BOM decodes as plain UTF-8', () => {
    expect(decodeBuffer(Buffer.from(sample, 'utf8'))).toEqual({ text: sample, enc: 'UTF-8' });
  });

  test('EF BB BF is stripped and decoded as UTF-8', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(sample, 'utf8')]);
    expect(decodeBuffer(buf)).toEqual({ text: sample, enc: 'UTF-8' });
  });

  test('FF FE is sniffed as UTF-16 LE and the BOM bytes are not decoded', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(sample, 'utf16le')]);
    expect(decodeBuffer(buf)).toEqual({ text: sample, enc: 'UTF-16 LE' });
  });

  test('FE FF is sniffed as UTF-16 BE and the BOM bytes are not decoded', () => {
    const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16BeBytes(sample)]);
    expect(decodeBuffer(buf)).toEqual({ text: sample, enc: 'UTF-16 BE' });
  });
});

describe('parseStringsText', () => {
  test('happy path: a well-formed entry parses with its declaration line', () => {
    const { entries, bad } = parseStringsText('"greeting" = "Hello";\n"farewell" = "Bye";\n');
    expect(entries).toEqual([
      { key: 'greeting', value: 'Hello', line: 1 },
      { key: 'farewell', value: 'Bye', line: 2 },
    ]);
    expect(bad).toEqual([]);
  });

  test('escape sequences: \\n \\t \\r \\" \\\\ all decode to their literal characters', () => {
    const { entries } = parseStringsText('"esc" = "a\\nb\\tc\\\\d\\"e\\rf";\n');
    expect(entries).toEqual([{ key: 'esc', value: 'a\nb\tc\\d"e\rf', line: 1 }]);
  });

  test('line comments are skipped without disturbing line numbers', () => {
    const text = ['// leading comment', '"k" = "v";'].join('\n');
    const { entries, bad } = parseStringsText(text);
    expect(entries).toEqual([{ key: 'k', value: 'v', line: 2 }]);
    expect(bad).toEqual([]);
  });

  test('block comments spanning several lines advance the line counter correctly', () => {
    const text = ['/* line1', 'line2', 'line3 */', '"key" = "value";'].join('\n');
    const { entries, bad } = parseStringsText(text);
    expect(entries).toEqual([{ key: 'key', value: 'value', line: 4 }]);
    expect(bad).toEqual([]);
  });

  test('an unterminated string reports "unterminated string" and aborts the rest of the scan', () => {
    const text = '"first" = "ok";\n"second" = "never closes';
    const { entries, bad } = parseStringsText(text);
    expect(entries).toEqual([{ key: 'first', value: 'ok', line: 1 }]);
    expect(bad).toEqual([{ line: 2, text: 'unterminated string' }]);
  });

  test('a missing "=" is reported and the rest of that line is skipped, but parsing resumes on the next line', () => {
    const text = ['"badkey" oops', '"good" = "fine";'].join('\n');
    const { entries, bad } = parseStringsText(text);
    expect(entries).toEqual([{ key: 'good', value: 'fine', line: 2 }]);
    expect(bad).toEqual([{ line: 1, text: 'expected = after the key' }]);
  });

  test('a non-quoted value is reported as "expected a quoted value"', () => {
    const text = ['"key1" = oops;', '"key2" = "fine";'].join('\n');
    const { entries, bad } = parseStringsText(text);
    expect(entries).toEqual([{ key: 'key2', value: 'fine', line: 2 }]);
    expect(bad).toEqual([{ line: 1, text: 'expected a quoted value' }]);
  });

  test('a missing semicolon is reported but the entry is still recorded and scanning continues', () => {
    const text = ['"a" = "one"', '"b" = "two";'].join('\n');
    const { entries, bad } = parseStringsText(text);
    expect(entries).toEqual([
      { key: 'a', value: 'one', line: 1 },
      { key: 'b', value: 'two', line: 2 },
    ]);
    expect(bad).toEqual([{ line: 1, text: 'missing semicolon' }]);
  });

  test('an unrecognised top-level line is reported verbatim (trimmed, truncated to 60 chars)', () => {
    const longJunk = 'x'.repeat(80);
    const text = [longJunk, '"k" = "v";'].join('\n');
    const { entries, bad } = parseStringsText(text);
    expect(entries).toEqual([{ key: 'k', value: 'v', line: 2 }]);
    expect(bad).toEqual([{ line: 1, text: 'x'.repeat(60) }]);
  });
});

describe('normaliseValue / escapeValue', () => {
  test('normaliseValue lowercases and ignores trailing punctuation, so "Done" and "Done." collide', () => {
    expect(normaliseValue('Done')).toBe('done');
    expect(normaliseValue('Done.')).toBe('done');
    expect(normaliseValue('DONE!!')).toBe('done');
  });

  test('normaliseValue trims leading and trailing whitespace', () => {
    expect(normaliseValue('  Spaced  ')).toBe('spaced');
  });

  test('escapeValue escapes backslash before quote/newline/tab/CR (order matters)', () => {
    expect(escapeValue('a\\b"c\nd\re\tf')).toBe('a\\\\b\\"c\\nd\\re\\tf');
  });
});

describe('checkStringsFiles', () => {
  const enContent = [
    '"greeting" = "Hello";',
    '"farewell" = "Goodbye";',
    '"untranslated" = "Stays Same";',
    '"only_in_base" = "Base only value";',
    '',
  ].join('\n');

  const frContent = [
    '"greeting" = "Bonjour";', // line 1
    '"untranslated" = "Stays Same";', // line 2 -- identical to base
    '"extra_key" = "Valeur supplémentaire";', // line 3 -- not in base
    '"dup_a" = "Cliquez ici";', // line 4
    '"dup_b" = "cliquez ici.";', // line 5 -- duplicate of dup_a, case/punctuation-insensitive
    'garbage line without quotes', // line 6 -- bad
    '"bad_key" bad', // line 7 -- bad (missing "=")
    '',
  ].join('\n');

  function baseAndFrResult(baseFile) {
    return checkStringsFiles({
      files: [
        { name: 'en.strings', content: utf8B64(enContent) },
        { name: 'fr.strings', content: utf8B64(frContent) },
      ],
      baseFile,
    });
  }

  test('auto-selects the base by the "en."/"base." name rule when no baseFile is given', () => {
    const result = baseAndFrResult(undefined);
    expect(result.baseFile).toBe('en.strings');
  });

  test('reports missing keys (present in base, absent elsewhere) with the base value', () => {
    const result = baseAndFrResult();
    expect(result.missingKeys).toEqual([
      { key: 'farewell', file: 'fr.strings', baseValue: 'Goodbye' },
      { key: 'only_in_base', file: 'fr.strings', baseValue: 'Base only value' },
    ]);
  });

  test('reports extra keys (present elsewhere, absent from base)', () => {
    const result = baseAndFrResult();
    expect(result.extraKeys).toEqual([
      { key: 'extra_key', file: 'fr.strings', value: 'Valeur supplémentaire' },
      { key: 'dup_a', file: 'fr.strings', value: 'Cliquez ici' },
      { key: 'dup_b', file: 'fr.strings', value: 'cliquez ici.' },
    ]);
  });

  test('reports values identical to the base', () => {
    const result = baseAndFrResult();
    expect(result.identicalToBase).toEqual([{ key: 'untranslated', file: 'fr.strings', value: 'Stays Same' }]);
  });

  test('reports duplicate values under different keys, case/trailing-punctuation-insensitive', () => {
    const result = baseAndFrResult();
    expect(result.duplicateValues).toEqual([{ file: 'fr.strings', value: 'Cliquez ici', keys: 'dup_a, dup_b' }]);
  });

  test('reports unparseable lines with file, line number and text', () => {
    const result = baseAndFrResult();
    expect(result.badLines).toEqual([
      { file: 'fr.strings', line: 6, text: 'garbage line without quotes' },
      { file: 'fr.strings', line: 7, text: 'expected = after the key' },
    ]);
  });

  test('issue count sums missing + duplicates + identical + bad lines, but excludes extra keys', () => {
    const result = baseAndFrResult();
    // missing(2) + dupes(1) + identical(1) + bad(2) = 6; extraKeys.length is 3 and must not be added.
    expect(result.issueCount).toBe(6);
    expect(result.extraKeys.length).toBe(3);
  });

  test('keysInBase counts distinct keys in the base file, fileCount counts loaded files', () => {
    const result = baseAndFrResult();
    expect(result.keysInBase).toBe(4);
    expect(result.fileCount).toBe(2);
  });

  test('missingKeysStrings renders ready-to-paste "key" = "value"; lines using the base value, escaped', () => {
    const result = baseAndFrResult();
    expect(result.missingKeysStrings).toBe('"farewell" = "Goodbye";\n"only_in_base" = "Base only value";');
  });

  test('per-file summary reports encoding and key/bad-line counts', () => {
    const result = baseAndFrResult();
    expect(result.files).toEqual([
      { name: 'en.strings', encoding: 'UTF-8', keyCount: 4, badLineCount: 0 },
      { name: 'fr.strings', encoding: 'UTF-8', keyCount: 5, badLineCount: 2 },
    ]);
  });

  test('an explicit baseFile overrides the name-based auto-selection', () => {
    const result = baseAndFrResult('fr.strings');
    expect(result.baseFile).toBe('fr.strings');
    // With fr as base, "extra_key"/"dup_a"/"dup_b" are now base keys, so en.strings is
    // reported missing them instead.
    expect(result.missingKeys.map((m) => m.key).sort()).toEqual(['dup_a', 'dup_b', 'extra_key']);
  });

  test('base auto-pick follows the name rule over alphabetical order, not just "first file"', () => {
    const trivial = '"k" = "v";\n';
    const files = [
      { name: 'aa_lang.strings', content: utf8B64(trivial) }, // sorts first alphabetically
      { name: 'en.strings', content: utf8B64(trivial) }, // matches the en./base. rule
      { name: 'fr.strings', content: utf8B64(trivial) },
    ];
    expect(checkStringsFiles({ files }).baseFile).toBe('en.strings');
  });

  test('an explicit baseFile that matches no loaded file falls back to the alphabetically-first file', () => {
    const trivial = '"k" = "v";\n';
    const files = [
      { name: 'aa_lang.strings', content: utf8B64(trivial) },
      { name: 'en.strings', content: utf8B64(trivial) },
      { name: 'fr.strings', content: utf8B64(trivial) },
    ];
    expect(checkStringsFiles({ files, baseFile: 'zz_missing.strings' }).baseFile).toBe('aa_lang.strings');
  });

  test('accepts UTF-16 (with BOM) files transparently alongside UTF-8 ones', () => {
    const result = checkStringsFiles({
      files: [
        { name: 'en.strings', content: utf8B64(enContent) },
        { name: 'fr.strings', content: utf16LeBomB64(frContent) },
      ],
    });
    expect(result.files.find((f) => f.name === 'fr.strings').encoding).toBe('UTF-16 LE');
    // Diff results should be identical to the plain-UTF-8 fr.strings case.
    expect(result.missingKeys).toEqual([
      { key: 'farewell', file: 'fr.strings', baseValue: 'Goodbye' },
      { key: 'only_in_base', file: 'fr.strings', baseValue: 'Base only value' },
    ]);
  });

  test('accepts a UTF-8 BOM file transparently', () => {
    const result = checkStringsFiles({
      files: [
        { name: 'en.strings', content: utf8BomB64(enContent) },
        { name: 'fr.strings', content: utf8B64(frContent) },
      ],
    });
    expect(result.files.find((f) => f.name === 'en.strings').encoding).toBe('UTF-8');
    expect(result.keysInBase).toBe(4);
  });

  test('throws when fewer than two files are supplied (caught by the tool handler, not thrown to the client)', () => {
    expect(() =>
      checkStringsFiles({ files: [{ name: 'only.strings', content: utf8B64('"a" = "b";') }] })
    ).toThrow('at least two .strings files are required to compare');
  });
});
