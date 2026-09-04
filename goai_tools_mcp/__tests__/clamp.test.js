'use strict';
const { computeClamp } = require('../controllers/tools/clamp');

describe('computeClamp', () => {
  test('typical case: the page defaults (16px @ 360px -> 32px @ 1280px, root 16)', () => {
    // slope = (32-16)/(1280-360) = 16/920 = 0.017391304347826088
    // intercept = 16 - 360*slope = 16 - 6.260869565217391 = 9.739130434782609
    // lo = min(16,32)/16 = 1, hi = max(16,32)/16 = 2
    // interceptRem = 9.739130434782609/16 = 0.6086956521739131 -> round4 -> 0.6087
    // slopeVw = slope*100 = 1.7391304347826088 -> round4 -> 1.7391
    const result = computeClamp({
      minSizePx: 16,
      minViewportPx: 360,
      maxSizePx: 32,
      maxViewportPx: 1280,
      rootFontSizePx: 16,
      previewViewportsPx: [360, 1280, 768],
      typeScale: { steps: 2, ratio: 1.2 },
    });

    expect(result.status).toBe('ok');
    expect(result.note).toBe('');
    expect(result.css).toBe('clamp(1rem, 0.6087rem + 1.7391vw, 2rem)');
    expect(result.math).toEqual({
      minRem: 1,
      maxRem: 2,
      interceptRem: 0.6087,
      slopeVw: 1.7391,
    });

    // at(360) and at(1280) land exactly on the two anchor points.
    expect(result.preview[0]).toEqual({ viewportPx: 360, computedSizePx: 16 });
    expect(result.preview[1]).toEqual({ viewportPx: 1280, computedSizePx: 32 });
    // at(768) = intercept + slope*768 = 9.739130434782609 + 13.356521739130435
    //         = 23.095652173913044 -> *100 = 2309.5652... -> round -> 2310 -> /100 = 23.1
    expect(result.preview[2]).toEqual({ viewportPx: 768, computedSizePx: 23.1 });

    // Type scale, ratio 1.2, 2 steps:
    // step 1: f=1.2^0=1 -> same endpoints/css as the base clamp.
    expect(result.scale[0]).toEqual({
      step: 1,
      ratioApplied: 1,
      minSizePx: 16,
      maxSizePx: 32,
      css: 'clamp(1rem, 0.6087rem + 1.7391vw, 2rem)',
    });
    // step 2: f=1.2^1=1.2 -> min 19.2px, max 38.4px.
    // slope = (38.4-19.2)/920 = 19.2/920 = 0.020869565217391304
    // intercept = 19.2 - 360*slope = 19.2 - 7.513043478260870 = 11.68695652173913
    // lo = 19.2/16 = 1.2, hi = 38.4/16 = 2.4
    // interceptRem = 11.68695652173913/16 = 0.7304347826086956 -> round4 -> 0.7304
    // slopeVw = 2.0869565217391304 -> round4 -> 2.087
    expect(result.scale[1]).toEqual({
      step: 2,
      ratioApplied: 1.2,
      minSizePx: 19.2,
      maxSizePx: 38.4,
      css: 'clamp(1.2rem, 0.7304rem + 2.087vw, 2.4rem)',
    });
  });

  test('edge case: equal viewports short-circuits to status "sameViewports" with no css/math/preview/scale', () => {
    const result = computeClamp({
      minSizePx: 16,
      minViewportPx: 500,
      maxSizePx: 32,
      maxViewportPx: 500,
      rootFontSizePx: 16,
      previewViewportsPx: [768],
      typeScale: { steps: 3, ratio: 1.25 },
    });

    expect(result).toEqual({
      status: 'sameViewports',
      note: 'The two viewports must differ.',
      css: null,
      math: null,
      preview: [],
      scale: [],
    });
  });

  test('flat case: equal sizes produce a constant clamp() and the "flat" note', () => {
    // slope = 0/920 = 0, intercept = 20, lo = hi = 20/16 = 1.25
    const result = computeClamp({
      minSizePx: 20,
      minViewportPx: 360,
      maxSizePx: 20,
      maxViewportPx: 1280,
      rootFontSizePx: 16,
    });
    expect(result.status).toBe('flat');
    expect(result.note).toBe('Both sizes are equal, so this is a constant — clamp() is not needed.');
    expect(result.css).toBe('clamp(1.25rem, 1.25rem + 0vw, 1.25rem)');
  });

  test('documented "impossible" case: max smaller than min still produces a valid (inverted) clamp()', () => {
    // slope = (16-32)/920 = -16/920 = -0.017391304347826088
    // intercept = 32 - 360*slope = 32 + 6.260869565217392 = 38.26086956521739
    // lo = min(32,16)/16 = 1, hi = max(32,16)/16 = 2
    // interceptRem = 38.26086956521739/16 = 2.391304347826087 -> round4 -> 2.3913
    // slopeVw = -1.7391304347826088 -> round4 -> -1.7391
    const result = computeClamp({
      minSizePx: 32,
      minViewportPx: 360,
      maxSizePx: 16,
      maxViewportPx: 1280,
      rootFontSizePx: 16,
    });
    expect(result.status).toBe('inverted');
    expect(result.note).toBe('Max is smaller than min, so the size shrinks as the screen grows.');
    expect(result.css).toBe('clamp(1rem, 2.3913rem + -1.7391vw, 2rem)');
    expect(result.math).toEqual({
      minRem: 1,
      maxRem: 2,
      interceptRem: 2.3913,
      slopeVw: -1.7391,
    });
  });

  test('rootFontSizePx of 0 falls back to 16, matching the source\'s `num("root") || 16`', () => {
    const withZeroRoot = computeClamp({
      minSizePx: 16,
      minViewportPx: 360,
      maxSizePx: 32,
      maxViewportPx: 1280,
      rootFontSizePx: 0,
    });
    const withDefaultRoot = computeClamp({
      minSizePx: 16,
      minViewportPx: 360,
      maxSizePx: 32,
      maxViewportPx: 1280,
      rootFontSizePx: 16,
    });
    expect(withZeroRoot.css).toBe(withDefaultRoot.css);
  });
});
