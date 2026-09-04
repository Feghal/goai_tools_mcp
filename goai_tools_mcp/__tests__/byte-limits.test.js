'use strict';

const byteLimits = require('../utils/byteLimits');

// utils/byteLimits.js is the single place every file-accepting tool goes for
// its size and pixel budgets, so these are the bounds the whole public
// surface inherits. They exist because this server is unauthenticated and
// capped at 400 MB of container memory -- see the arithmetic in that file.

describe('MAX_INPUT_BYTES', () => {
  test('defaults to 4 MB, the value the container memory budget was solved for', () => {
    // 3 live copies of the payload coexist per request (raw body ~1.4x,
    // parsed JSON string ~1.33x, decoded Buffer 1x) => ~3.67x overhead.
    // At 4 MB that is ~15 MB, against a ~210 MB per-call budget.
    expect(byteLimits.MAX_INPUT_BYTES).toBe(4 * 1000 * 1000);
  });

  test('the Express body limit derived from it in server.js still lands on 6mb', () => {
    // server.js:37 computes ceil(MAX_INPUT_BYTES * 1.4 / 1e6) mb. That file
    // is owned elsewhere, so this asserts the INPUT to its formula rather
    // than editing it -- if MAX_INPUT_BYTES moves, this test says what the
    // body limit (and nginx's client_max_body_size above it) must become.
    const derivedMb = Math.ceil((byteLimits.MAX_INPUT_BYTES * 1.4) / 1e6);
    expect(derivedMb).toBe(6);
  });
});

describe('decode', () => {
  test('accepts a payload at the limit and rejects one over it', () => {
    const ok = Buffer.alloc(1000).toString('base64');
    expect(byteLimits.decode(ok, 1000).length).toBe(1000);
    expect(() => byteLimits.decode(Buffer.alloc(1001).toString('base64'), 1000)).toThrow(
      byteLimits.InputTooLargeError
    );
  });

  test('rejects from the base64 string length, without allocating the buffer', () => {
    // The whole point of estimateDecodedSize: a caller must not be able to
    // force a 100 MB allocation just to be told it was too big.
    const huge = 'A'.repeat(100 * 1000 * 1000);
    expect(byteLimits.estimateDecodedSize(huge)).toBeGreaterThan(byteLimits.MAX_INPUT_BYTES);
    expect(() => byteLimits.decode(huge)).toThrow(byteLimits.InputTooLargeError);
  });
});

describe('decodeBatch', () => {
  test('enforces the aggregate cap across files, not just the per-file cap', () => {
    // Each file is individually well under MAX_INPUT_BYTES; together they are
    // over MAX_TOTAL_INPUT_BYTES. This is the hole a per-file-only check
    // leaves open for every batch tool.
    const half = Buffer.alloc(Math.floor(byteLimits.MAX_TOTAL_INPUT_BYTES * 0.6)).toString('base64');
    const files = [{ b: half }, { b: half }];

    expect(() => byteLimits.decodeBatch(files, (f) => f.b)).toThrow(byteLimits.InputTooLargeError);
  });

  test('decodes a batch that fits, preserving input order', () => {
    const files = [{ b: Buffer.from('one').toString('base64') }, { b: Buffer.from('two').toString('base64') }];
    const out = byteLimits.decodeBatch(files, (f) => f.b);
    expect(out.map((b) => b.toString('utf8'))).toEqual(['one', 'two']);
  });
});

describe('assertPixelBudget', () => {
  test('accepts a full-frame DSLR photo (24 MP) and rejects a decompression bomb', () => {
    expect(() => byteLimits.assertPixelBudget(6000, 4000, 'test')).not.toThrow();
    expect(() => byteLimits.assertPixelBudget(16000, 16000, 'test')).toThrow(byteLimits.ImageTooLargeError);
  });

  test('names the dimensions and the limit, so the caller knows what to change', () => {
    expect(() => byteLimits.assertPixelBudget(16000, 16000, 'my_tool')).toThrow(/my_tool/);
    expect(() => byteLimits.assertPixelBudget(16000, 16000, 'my_tool')).toThrow(/16000x16000/);
    expect(() => byteLimits.assertPixelBudget(16000, 16000, 'my_tool')).toThrow(
      new RegExp(String(byteLimits.MAX_DECODED_PIXELS))
    );
  });

  test('sharpLimits() overrides libvips own ~1.07 GB default', () => {
    expect(byteLimits.sharpLimits().limitInputPixels).toBe(byteLimits.MAX_DECODED_PIXELS);
    expect(byteLimits.MAX_DECODED_PIXELS).toBeLessThan(0x3fff * 0x3fff);
  });
});

describe('assertSquarableSide', () => {
  test('rejects a thin strip that would square to gigabytes despite tiny pixel count', () => {
    // The case the pixel budget alone cannot catch: 1 x 30000 is 30,000
    // pixels (passes assertPixelBudget) but squares to 30000 x 30000 = 3.6 GB.
    expect(() => byteLimits.assertPixelBudget(1, 30000, 'test')).not.toThrow();
    expect(() => byteLimits.assertSquarableSide(1, 30000, 'test')).toThrow(byteLimits.ImageTooLargeError);
  });

  test('accepts a source at the per-side limit', () => {
    const side = byteLimits.MAX_SQUARE_SOURCE_SIDE;
    expect(() => byteLimits.assertSquarableSide(side, side, 'test')).not.toThrow();
    expect(() => byteLimits.assertSquarableSide(side + 1, 10, 'test')).toThrow(byteLimits.ImageTooLargeError);
  });
});
