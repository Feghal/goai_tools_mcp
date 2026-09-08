'use strict';

const { z } = require('zod');
const sharp = require('sharp');

// This server is PUBLIC and UNAUTHENTICATED on a 1 GB box with a 400 MB
// container cap, so every tool needs a bound on the dimension an adversarial
// caller would push. These tests pin the bounds that were added for that,
// each against the concrete abuse it exists to stop -- and, just as
// importantly, each against a legitimate call that must still work.

// Most tools register a raw zod SHAPE (a plain object of fields); a few
// register a z.object() because they carry cross-field refinements. Normalise
// both to something with .safeParse().
function schemaOf(toolPath, toolName) {
  const captured = {};
  const stubServer = {
    registerTool(name, config) {
      captured[name] = config.inputSchema;
    },
  };
  require(toolPath).register(stubServer);
  const raw = captured[toolName];
  if (!raw) throw new Error(`tool ${toolName} not registered by ${toolPath}`);
  return typeof raw.safeParse === 'function' ? raw : z.object(raw);
}

const b64 = (buf) => buf.toString('base64');
const solidPng = (w, h) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png({ compressionLevel: 9 })
    .toBuffer();

// ---------------------------------------------------------------------------
// Decode bombs: a small compressed file that decodes to an enormous bitmap
// ---------------------------------------------------------------------------

describe('image decode bombs', () => {
  // 30 s: these build real multi-megapixel PNGs before asserting on them.
  jest.setTimeout(60000);

  test('generate_app_icon_set refuses a 221-byte strip that would square to 3.6 GB', async () => {
    const { generateAppIconSet } = require('../controllers/tools/app-icon');
    // 1 x 30000 is only 30,000 pixels, so no pixel-count check catches it --
    // but flatten() centres it on a max(w,h) square, i.e. 30000 x 30000 RGBA.
    const strip = await solidPng(1, 30000);
    expect(strip.length).toBeLessThan(2000); // it really is a tiny file

    await expect(generateAppIconSet({ imageBase64: b64(strip), variants: 'none', backgroundColor: '#fff' }))
      .rejects.toThrow(/square canvas/);
  });

  test('generate_favicon_set refuses the same strip, via its { error } channel', async () => {
    const { generateFaviconSet } = require('../controllers/tools/favicon');
    const strip = await solidPng(30000, 1);
    const result = await generateFaviconSet({ imageBase64: b64(strip) });
    expect(result.error).toMatch(/square canvas/);
    expect(result.files).toBeUndefined();
  });

  test('generate_app_icon_set still accepts a normal 1024x1024 source', async () => {
    const { generateAppIconSet } = require('../controllers/tools/app-icon');
    const src = await solidPng(1024, 1024);
    const result = await generateAppIconSet({ imageBase64: b64(src), variants: 'none', backgroundColor: '#ffffff' });
    expect(result.stats.source).toEqual({ width: 1024, height: 1024 });
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  test('image_compress refuses a 16000x16000 PNG that ships in under a megabyte', async () => {
    const { compressImage } = require('../controllers/tools/compress');
    const bomb = await solidPng(16000, 16000);
    expect(bomb.length).toBeLessThan(1000 * 1000);

    await expect(
      compressImage({ imageBase64: b64(bomb), format: 'jpeg', quality: 75, maxDimension: 1600 })
    ).rejects.toThrow(/decode limit/);
  });

  test('image_compress still accepts a 24 MP photo, at the pixel budget', async () => {
    const { compressImage } = require('../controllers/tools/compress');
    const photo = await solidPng(6000, 4000);
    const result = await compressImage({ imageBase64: b64(photo), format: 'jpeg', quality: 75, maxDimension: 1600 });
    expect(result.stats.original).toMatchObject({ width: 6000, height: 4000 });
    expect(result.stats.working.width).toBe(1600);
  });

  test('resize_images refuses a decode bomb and names the offending file', async () => {
    const { resizeImages } = require('../controllers/tools/resize');
    const bomb = await solidPng(16000, 16000);
    await expect(
      resizeImages({
        images: [{ name: 'bomb.png', imageBase64: b64(bomb) }],
        preset: 'og',
        fit: 'contain',
        paddingColor: '#ffffff',
      })
    ).rejects.toThrow(/bomb\.png[\s\S]*decode limit/);
  });
});

// ---------------------------------------------------------------------------
// compress: the curve's 14 repeated encodes get their own tighter cap
// ---------------------------------------------------------------------------

describe('image_compression_curve', () => {
  const compress = require('../controllers/tools/compress');

  test('caps maxDimension below image_compress, because it encodes 14 times', () => {
    expect(compress.MAX_CURVE_MAX_DIMENSION).toBeLessThan(compress.MAX_MAX_DIMENSION);

    const schema = schemaOf('../controllers/tools/compress', 'image_compression_curve');
    expect(schema.safeParse({ imageBase64: 'AA==', maxDimension: compress.MAX_CURVE_MAX_DIMENSION }).success).toBe(true);
    expect(schema.safeParse({ imageBase64: 'AA==', maxDimension: compress.MAX_CURVE_MAX_DIMENSION + 1 }).success).toBe(
      false
    );
  });

  test('clamps maxDimension even when called directly, bypassing the schema', async () => {
    // At the old shared 4000 cap this exact call peaked at 499 MB and 31 s.
    const photo = await solidPng(6000, 4000);
    const result = await compress.compressionCurve({
      imageBase64: b64(photo),
      format: 'jpeg',
      maxDimension: 999999,
    });
    expect(result.working.maxDimension).toBe(compress.MAX_CURVE_MAX_DIMENSION);
    expect(Math.max(result.working.width, result.working.height)).toBeLessThanOrEqual(
      compress.MAX_CURVE_MAX_DIMENSION
    );
    expect(result.points).toHaveLength(14);
  }, 60000);

  test('encodes sequentially, so peak memory does not scale with the level count', () => {
    // One shared vCPU: concurrency buys no wall-clock time but multiplies
    // the live intermediate buffers.
    expect(compress.CURVE_ENCODE_CONCURRENCY).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resize: fan-out is images x sizes, so neither alone is the right bound
// ---------------------------------------------------------------------------

describe('resize_images fan-out', () => {
  const resize = require('../controllers/tools/resize');

  test('rejects a batch whose total output pixels exceed the per-call budget', async () => {
    // appstoreIpad is 2064x2752 = 5.68 MP per image; the old .max(200) let
    // 200 of them (1136 MP of PNG) through in one call.
    const tiny = await solidPng(8, 8);
    const images = Array.from({ length: 40 }, (_, i) => ({ name: `s${i}.png`, imageBase64: b64(tiny) }));

    await expect(
      resizeImages_(images, 'appstoreIpad')
    ).rejects.toThrow(/output pixels, over the/);
  });

  test('the same image count is fine for a preset with small outputs', async () => {
    const tiny = await solidPng(8, 8);
    const images = Array.from({ length: 40 }, (_, i) => ({ name: `s${i}.png`, imageBase64: b64(tiny) }));
    const result = await resizeImages_(images, 'favicon');
    expect(result.stats.imagesIn).toBe(40);
    expect(result.stats.filesOut).toBe(40 * 6);
  }, 60000);

  test('a real App Store batch (10 screenshots, one device size) still works', async () => {
    const shot = await solidPng(100, 200);
    const images = Array.from({ length: 10 }, (_, i) => ({ name: `shot${i}.png`, imageBase64: b64(shot) }));
    const result = await resizeImages_(images, 'appstore69');
    expect(result.stats.filesOut).toBe(10);
  }, 60000);

  test('the image-count cap came down from 200', () => {
    expect(resize.MAX_IMAGES).toBe(60);
    const schema = schemaOf('../controllers/tools/resize', 'resize_images');
    const many = Array.from({ length: resize.MAX_IMAGES + 1 }, () => ({ name: 'a.png', imageBase64: 'AA==' }));
    expect(schema.safeParse({ images: many }).success).toBe(false);
  });

  function resizeImages_(images, preset) {
    return resize.resizeImages({ images, preset, fit: 'contain', paddingColor: '#ffffff' });
  }
});

// ---------------------------------------------------------------------------
// strings-checker: the quadratic duplicate scan
// ---------------------------------------------------------------------------

describe('check_strings_files duplicate scan', () => {
  const { checkStringsFiles, MAX_ENTRIES_PER_FILE, MAX_FILES } = require('../controllers/tools/strings-checker');

  function dupeFile(pairs) {
    let s = '';
    for (let i = 0; i < pairs; i++) s += `"a${i}"="v${i}";\n"b${i}"="v${i}";\n`;
    return b64(Buffer.from(s, 'utf8'));
  }
  const other = { name: 'zz.strings', content: b64(Buffer.from('"x"="y";', 'utf8')) };

  test('scales linearly, not quadratically, in the number of duplicate groups', () => {
    // The old code re-scanned every entry for EVERY duplicate group. Measured
    // on it: 4000 pairs took 1057 ms and the curve was cleanly O(n^2), which
    // extrapolates to ~16 minutes of blocked event loop on a 4 MB file.
    const time = (pairs) => {
      const t0 = Date.now();
      checkStringsFiles({ files: [{ name: 'en.strings', content: dupeFile(pairs) }, other] });
      return Date.now() - t0;
    };
    time(2000); // warm up, so JIT effects don't land on the first measurement
    const small = time(2000);
    const large = time(8000);

    // 4x the input. Quadratic would be ~16x; linear is ~4x. Assert well
    // under the quadratic prediction rather than pinning a wall-clock number.
    expect(large).toBeLessThan(Math.max(small, 5) * 10);
  }, 60000);

  test('still reports the first original value and every key in the group', () => {
    // Exact output parity with the code the fix replaced.
    const src = '"greet"="Done";\n"finish"="done.";\n"other"="Keep";';
    const result = checkStringsFiles({
      files: [{ name: 'en.strings', content: b64(Buffer.from(src, 'utf8')) }, other],
    });
    expect(result.duplicateValues).toEqual([{ file: 'en.strings', value: 'Done', keys: 'greet, finish' }]);
  });

  test('a value of "__proto__" no longer crashes the duplicate scan', () => {
    // The old plain-object accumulator did `byValue['__proto__'] || []`,
    // which returned Object.prototype and then threw "push is not a function".
    const src = '"k1"="__proto__";\n"k2"="__proto__";';
    const result = checkStringsFiles({
      files: [{ name: 'en.strings', content: b64(Buffer.from(src, 'utf8')) }, other],
    });
    expect(result.duplicateValues).toEqual([{ file: 'en.strings', value: '__proto__', keys: 'k1, k2' }]);
  });

  test('rejects a file with more entries than any real app ships', () => {
    let s = '';
    for (let i = 0; i < MAX_ENTRIES_PER_FILE + 1; i++) s += `"k${i}"="v${i}";\n`;
    expect(() =>
      checkStringsFiles({ files: [{ name: 'big.strings', content: b64(Buffer.from(s, 'utf8')) }, other] })
    ).toThrow(/entries, over the/);
  }, 60000);

  test('caps the file count', () => {
    const schema = schemaOf('../controllers/tools/strings-checker', 'check_strings_files');
    const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ name: `f${i}`, content: 'QQ==' }));
    expect(schema.safeParse({ files }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// appstore: outbound load aimed at Apple, from our IP
// ---------------------------------------------------------------------------

describe('appstore outbound-load bounds', () => {
  const appstore = require('../controllers/tools/appstore');
  const appstoreLink = require('../controllers/tools/appstore-link');

  test('a multi-megabyte run of digits is not accepted as an app id', () => {
    // It used to be: the whole 3 MB became the id and was interpolated into
    // the lookup URL, then sent to Apple once per storefront (up to 30).
    const huge = '9'.repeat(3 * 1000 * 1000);
    expect(appstore.extractAppId(huge)).toBeNull();
    expect(appstoreLink.extractAppId(huge)).toBe('');
  });

  test('real App Store ids still extract, from a bare id and from a URL', () => {
    expect(appstore.extractAppId('6742322421')).toBe('6742322421');
    expect(appstore.extractAppId('https://apps.apple.com/us/app/x/id6742322421')).toBe('6742322421');
    expect(appstoreLink.extractAppId('https://apps.apple.com/us/app/x/id6478912345')).toBe('6478912345');
  });

  test('the search term cannot become a multi-megabyte query string', () => {
    const schema = schemaOf('../controllers/tools/appstore', 'appstore_search');
    expect(schema.safeParse({ term: 'notes app', country: 'US', entity: 'software' }).success).toBe(true);
    expect(schema.safeParse({ term: 'x'.repeat(appstore.MAX_SEARCH_TERM_CHARS + 1) }).success).toBe(false);
  });

  test('the storefront array is bounded at the schema, before de-duplication', () => {
    // normalizeStorefronts() de-dupes, so 1,000,000 copies of "US" used to
    // normalise down to one passing code -- after a million iterations.
    const schema = schemaOf('../controllers/tools/appstore', 'appstore_compare_markets');
    const flood = Array.from({ length: 1000 }, () => 'US');
    expect(schema.safeParse({ appIdOrUrl: '6742322421', storefronts: flood }).success).toBe(false);
    expect(schema.safeParse({ appIdOrUrl: '6742322421', storefronts: ['US', 'GB'] }).success).toBe(true);
  });

  test('campaign tokens cannot be used to inflate the returned URL', () => {
    const schema = schemaOf('../controllers/tools/appstore-link', 'build_app_store_link');
    const base = { appIdOrUrl: '6478912345', store: 'us' };
    expect(schema.safeParse({ ...base, ct: 'summer-sale' }).success).toBe(true);
    expect(schema.safeParse({ ...base, ct: 'x'.repeat(appstoreLink.MAX_TOKEN_CHARS + 1) }).success).toBe(false);
    expect(schema.safeParse({ ...base, pt: 'x'.repeat(appstoreLink.MAX_TOKEN_CHARS + 1) }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mobileprovision: XML depth and size
// ---------------------------------------------------------------------------

describe('inspect_mobileprovision plist bounds', () => {
  const { inspectMobileprovision, MAX_PLIST_CHARS } = require('../controllers/tools/mobileprovision');

  test('deep nesting is refused instead of overflowing the stack', () => {
    // Verified on the old code: ~50,000 nested <array> elements raised
    // RangeError: Maximum call stack size exceeded out of the recursive
    // parseNode(). Caught by register(), but not a condition to rely on
    // catching in a long-lived shared process.
    const depth = 50000;
    const xml = `<?xml version="1.0"?><plist>${'<array>'.repeat(depth)}${'</array>'.repeat(depth)}</plist>`;
    const result = inspectMobileprovision(b64(Buffer.from(xml, 'utf8')));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('plist_too_deep');
  }, 60000);

  test('an oversized plist is refused before it is parsed', () => {
    const filler = '<string>x</string>'.repeat(Math.ceil(MAX_PLIST_CHARS / 18) + 10);
    const xml = `<?xml version="1.0"?><plist><array>${filler}</array></plist>`;
    const result = inspectMobileprovision(b64(Buffer.from(xml, 'utf8')));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('plist_too_large');
  }, 60000);

  test('a normally-nested plist still parses', () => {
    const xml =
      '<?xml version="1.0"?><plist><dict><key>Name</key><string>Wildcard</string>' +
      '<key>ProvisionedDevices</key><array><string>abc</string></array></dict></plist>';
    const result = inspectMobileprovision(b64(Buffer.from(xml, 'utf8')));
    expect(result.ok).toBe(true);
    expect(result.name).toBe('Wildcard');
    expect(result.deviceCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// exif-strip: segment/chunk counts
// ---------------------------------------------------------------------------

describe('strip_image_metadata segment bounds', () => {
  const { jpegSegments, MAX_SEGMENTS } = require('../controllers/tools/exif-strip');

  test('a JPEG made almost entirely of minimum-size segments is refused', () => {
    // A JPEG segment costs 4 bytes (marker + a length of 2), so a 4 MB input
    // could otherwise yield ~1,000,000 descriptor objects.
    const count = MAX_SEGMENTS + 100;
    const buf = Buffer.alloc(2 + count * 4);
    buf[0] = 0xff;
    buf[1] = 0xd8;
    for (let i = 0; i < count; i++) {
      const at = 2 + i * 4;
      buf[at] = 0xff;
      buf[at + 1] = 0xe5; // APP5, not one this tool treats as metadata
      buf[at + 2] = 0x00;
      buf[at + 3] = 0x02; // length 2 => zero-length body, minimum advance
    }
    expect(jpegSegments(buf)).toBeNull();
  });

  test('an ordinary JPEG still walks', async () => {
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .toBuffer();
    const segs = jpegSegments(jpeg);
    expect(Array.isArray(segs)).toBe(true);
    expect(segs.length).toBeGreaterThan(0);
    expect(segs.length).toBeLessThan(MAX_SEGMENTS);
  });
});

// ---------------------------------------------------------------------------
// Response amplifiers: small input, large result
// ---------------------------------------------------------------------------

describe('response amplifiers are bounded', () => {
  test('estimate_ai_tokens caps its text (4 global .match() passes over it)', () => {
    // Measured on the old unbounded field: 6,000,000 non-ASCII characters
    // cost 219 MB of heap inside estimateTokens() alone.
    const { MAX_TEXT_CHARS, MAX_CONTEXT_WINDOWS } = require('../controllers/tools/ai-tokens');
    const schema = schemaOf('../controllers/tools/ai-tokens', 'estimate_ai_tokens');
    expect(schema.safeParse({ text: 'x'.repeat(MAX_TEXT_CHARS) }).success).toBe(true);
    expect(schema.safeParse({ text: 'x'.repeat(MAX_TEXT_CHARS + 1) }).success).toBe(false);

    const windows = Array.from({ length: MAX_CONTEXT_WINDOWS + 1 }, (_, i) => ({ name: `w${i}`, sizeTokens: 1000 }));
    expect(schema.safeParse({ text: 'hi', contextWindows: windows }).success).toBe(false);
  });

  test('bpm_delay_calculator caps divisions and taps', () => {
    // Each division becomes a ~150-byte delayTable row from ~2 bytes of input.
    const { MAX_DIVISIONS, MAX_TAPS } = require('../controllers/tools/bpm');
    const schema = schemaOf('../controllers/tools/bpm', 'bpm_delay_calculator');
    expect(schema.safeParse({ bpm: 120, divisions: [1, 2, 4, 8, 16, 32] }).success).toBe(true);
    expect(schema.safeParse({ bpm: 120, divisions: new Array(MAX_DIVISIONS + 1).fill(4) }).success).toBe(false);
    expect(schema.safeParse({ tapTimesMs: new Array(MAX_TAPS + 1).fill(0).map((_, i) => i * 500) }).success).toBe(
      false
    );
  });

  test('css_clamp_calculator caps its preview list', () => {
    const { MAX_PREVIEW_VIEWPORTS } = require('../controllers/tools/clamp');
    const schema = schemaOf('../controllers/tools/clamp', 'css_clamp_calculator');
    const base = { minSizePx: 16, minViewportPx: 320, maxSizePx: 24, maxViewportPx: 1280 };
    expect(schema.safeParse({ ...base, previewViewportsPx: [320, 768, 1280] }).success).toBe(true);
    expect(
      schema.safeParse({ ...base, previewViewportsPx: new Array(MAX_PREVIEW_VIEWPORTS + 1).fill(400) }).success
    ).toBe(false);
  });

  test('recipe_scale caps both line count and line length', () => {
    const { MAX_LINES, MAX_LINE_CHARS } = require('../controllers/tools/recipe');
    const schema = schemaOf('../controllers/tools/recipe', 'recipe_scale');
    expect(schema.safeParse({ lines: ['2 cups all-purpose flour'] }).success).toBe(true);
    expect(schema.safeParse({ lines: new Array(MAX_LINES + 1).fill('1 cup water') }).success).toBe(false);
    expect(schema.safeParse({ lines: ['x'.repeat(MAX_LINE_CHARS + 1)] }).success).toBe(false);
  });

  test('contrast fields cannot echo a huge value back through the error message', () => {
    // badHexError() interpolates the rejected value into its message.
    const { MAX_COLOR_CHARS } = require('../controllers/tools/contrast');
    const schema = schemaOf('../controllers/tools/contrast', 'check_contrast');
    expect(schema.safeParse({ foreground: '#6b7280', background: '#ffffff' }).success).toBe(true);
    expect(schema.safeParse({ foreground: 'x'.repeat(MAX_COLOR_CHARS + 1), background: '#fff' }).success).toBe(false);
  });

  test('enum-valued arrays are capped in LENGTH, not just in the values they admit', () => {
    // z.enum() bounds each entry's value; without a .max() the array itself
    // is still unbounded, and the dedupe loop runs once per entry.
    const { SDK_IDS } = require('../controllers/tools/privacy-label');
    const { PLANT_IDS } = require('../controllers/tools/plant-watering');

    const privacy = schemaOf('../controllers/tools/privacy-label', 'build_app_privacy_label');
    expect(privacy.safeParse({ items: new Array(SDK_IDS.length + 1).fill(SDK_IDS[0]) }).success).toBe(false);
    expect(privacy.safeParse({ items: [SDK_IDS[0], SDK_IDS[1]] }).success).toBe(true);

    const plants = schemaOf('../controllers/tools/plant-watering', 'plant_watering_calendar');
    expect(plants.safeParse({ plants: new Array(PLANT_IDS.length + 1).fill(PLANT_IDS[0]) }).success).toBe(false);
    expect(plants.safeParse({ plants: [PLANT_IDS[0]] }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Aggregate input across batch tools
// ---------------------------------------------------------------------------

describe('batch tools enforce an aggregate input cap', () => {
  const byteLimits = require('../utils/byteLimits');

  test('convert_heic_to_jpg_png sums its files rather than checking each alone', async () => {
    const { convertHeicBatch } = require('../controllers/tools/heic-convert');
    // Each file is comfortably under the per-file cap; together they bust the
    // aggregate. Before this, 50 files x MAX_INPUT_BYTES was reachable.
    const chunk = b64(Buffer.alloc(Math.floor(byteLimits.MAX_TOTAL_INPUT_BYTES * 0.6)));
    await expect(
      convertHeicBatch({
        files: [
          { filename: 'a.heic', dataBase64: chunk },
          { filename: 'b.heic', dataBase64: chunk },
        ],
        format: 'image/jpeg',
        quality: 90,
      })
    ).rejects.toThrow(byteLimits.InputTooLargeError);
  }, 60000);

  test('check_strings_files does the same', () => {
    const { checkStringsFiles } = require('../controllers/tools/strings-checker');
    const chunk = b64(Buffer.alloc(Math.floor(byteLimits.MAX_TOTAL_INPUT_BYTES * 0.6)));
    expect(() =>
      checkStringsFiles({
        files: [
          { name: 'en.strings', content: chunk },
          { name: 'fr.strings', content: chunk },
        ],
      })
    ).toThrow(byteLimits.InputTooLargeError);
  }, 60000);
});
