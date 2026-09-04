'use strict';
const { convertColor, buildRamp, convertInputSchema, rampInputSchema, parseColor } = require('../controllers/tools/oklch');

describe('oklch_convert: convertColor', () => {
  test('typical case: grey l=0.5 c=0 h=180 (chroma 0 collapses the matrices to a single scalar)', () => {
    // With c=0, oklchToLab gives a=b=0 regardless of h, so oklabToLinear's
    // l_/m_/s_ all equal L=0.5, and the OKLab->linear-sRGB matrix rows each
    // sum to 1.0 by construction, so linear r=g=b=L^3=0.125 exactly.
    // toGamma(0.125) = 1.055 * 0.125^(1/2.4) - 0.055
    //                = 1.055 * 2^(-1.25) - 0.055        (0.125 = 2^-3, 1/2.4 * 3 = 1.25)
    //                = 1.055 * 0.4204482076 - 0.055
    //                = 0.4435728590 - 0.055 = 0.388572859
    // *255 = 99.086079... -> rounds to 99 -> hex 0x63 -> '#636363'.
    const result = convertColor({ l: 0.5, c: 0, h: 180 });

    expect(result.requested).toEqual({ l: 0.5, c: 0, h: 180 });
    expect(result.oklchText).toBe('oklch(50% 0 180)');
    expect(result.inGamut).toBe(true);
    expect(result.mapped).toBe(false);
    expect(result.mappedChroma).toBeUndefined();
    expect(result.hex).toBe('#636363');
    expect(result.rgb).toEqual({ r: 99, g: 99, b: 99 });
    expect(result.rgbText).toBe('rgb(99 99 99)');
    // HSL of an r=g=b grey: h=0, s=0, l = 0.388572859*100 = 38.857286 -> 38.9
    expect(result.hsl).toEqual({ h: 0, s: 0, l: 38.9 });
    expect(result.hslText).toBe('hsl(0 0% 38.9%)');
  });

  test('edge case: l>=1 always reports mapped:true, even though white is representable (source quirk in gamutMap)', () => {
    // gamutMap()'s first branch triggers purely on col.l >= 1, independent of
    // c/h, and hard-codes { rgb: white, oklch: {l:1,c:0,h:col.h}, mapped:true }.
    const result = convertColor({ l: 1, c: 0.2, h: 100 });

    expect(result.requested).toEqual({ l: 1, c: 0.2, h: 100 });
    expect(result.oklchText).toBe('oklch(100% 0.2 100)');
    expect(result.mapped).toBe(true);
    expect(result.inGamut).toBe(false);
    expect(result.mappedChroma).toBe(0);
    expect(result.hex).toBe('#ffffff');
    expect(result.rgb).toEqual({ r: 255, g: 255, b: 255 });
    expect(result.rgbText).toBe('rgb(255 255 255)');
    expect(result.hsl).toEqual({ h: 0, s: 0, l: 100 });
    expect(result.hslText).toBe('hsl(0 0% 100%)');
  });

  test('unparseable color text throws the source\'s exact "bad" message (caught by register() and turned into toolResult.fail)', () => {
    expect(() => convertColor({ color: 'not-a-colour' })).toThrow('Not a colour this understands.');
    expect(parseColor('not-a-colour')).toBeNull();
  });

  test('color string takes precedence and round-trips through the same hex parser/formatter as the page', () => {
    // '#5b8cff' -> parse() expands nothing (already 6 digits), rgbToOklch(91,140,255).
    // Round-tripping it back through gamutMap+hex should reproduce the same
    // sRGB hex, since the source hex is itself in-gamut by definition.
    const result = convertColor({ color: '#5b8cff' });
    expect(result.hex).toBe('#5b8cff');
    expect(result.mapped).toBe(false);
  });
});

describe('oklch_convert: cross-field validation (convertInputSchema)', () => {
  test('rejects when neither color nor a full l/c/h triple is given', () => {
    expect(convertInputSchema.safeParse({}).success).toBe(false);
    expect(convertInputSchema.safeParse({ l: 0.5, c: 0.1 }).success).toBe(false); // h missing
  });

  test('accepts color alone, or a complete l/c/h triple', () => {
    expect(convertInputSchema.safeParse({ color: '#fff' }).success).toBe(true);
    expect(convertInputSchema.safeParse({ l: 0.5, c: 0.1, h: 10 }).success).toBe(true);
  });
});

describe('oklch_ramp: buildRamp', () => {
  test('typical case: light-mode ramp with base chroma 0 (each step is L^3 grey, hand-verifiable)', () => {
    // mode 'light' ignores base.l and uses l = 0.15 + f*0.8 for f = i/(steps-1);
    // steps=3 -> f = 0, 0.5, 1 -> l = 0.15, 0.55, 0.95. With c=0 every step is
    // grey (linear = l^3), independently confirmed against a standalone
    // transcription of the source math:
    //   l=0.15 -> linear 0.003375 -> gamma*255 = 11.088... -> '#0b0b0b'
    //   l=0.55 -> linear 0.166375 -> gamma*255 = 113.397... -> '#717171'
    //   l=0.95 -> linear 0.857375 -> gamma*255 = 238.292... -> '#eeeeee'
    const result = buildRamp({ l: 0.5, c: 0, h: 200, mode: 'light', steps: 3, name: 'brand' });

    expect(result.mode).toBe('light');
    expect(result.base).toEqual({ l: 0.5, c: 0, h: 200 });
    expect(result.steps).toHaveLength(3);

    expect(result.steps[0]).toEqual({ index: 1, oklch: { l: 0.15, c: 0, h: 200 }, oklchText: 'oklch(15% 0 200)', hex: '#0b0b0b', mapped: false });
    expect(result.steps[1]).toEqual({ index: 2, oklch: { l: 0.55, c: 0, h: 200 }, oklchText: 'oklch(55% 0 200)', hex: '#717171', mapped: false });
    // 0.15 + 1*0.8 is 0.9500000000000001 in IEEE754 double, not exactly 0.95 —
    // real float noise from the source's own formula, not this port's doing;
    // the *displayed* oklchText still rounds cleanly to "95%".
    expect(result.steps[2]).toEqual({ index: 3, oklch: { l: 0.9500000000000001, c: 0, h: 200 }, oklchText: 'oklch(95% 0 200)', hex: '#eeeeee', mapped: false });

    expect(result.css).toBe(
      ':root {\n' +
      '  --brand-1: oklch(15% 0 200);  /* #0b0b0b */\n' +
      '  --brand-2: oklch(55% 0 200);  /* #717171 */\n' +
      '  --brand-3: oklch(95% 0 200);  /* #eeeeee */\n' +
      '}'
    );
  });

  test('edge case: steps=0 falls back to 9, not clamped up to the minimum of 3 (source: +value || 9 runs before the clamp)', () => {
    const result = buildRamp({ l: 0.5, c: 0.1, h: 0, mode: 'hue', steps: 0, name: 'x' });
    expect(result.steps).toHaveLength(9);
  });

  test('name is sanitized exactly like the page: case preserved (regex is case-insensitive), runs of other characters collapse to a single hyphen', () => {
    // "My Brand!!" -> the space and the "!!" are each one run of
    // non-[a-z0-9-] characters -> each becomes a single '-', giving
    // "My-Brand-"; the css template then appends its own "-1" separator,
    // so the sanitized trailing hyphen and the template's hyphen both show
    // up: "--My-Brand--1". A quirk of the source's own regex, preserved here.
    const result = buildRamp({ l: 0.5, c: 0, h: 0, mode: 'light', steps: 3, name: 'My Brand!!' });
    expect(result.css).toContain('--My-Brand--1:');
  });
});

describe('oklch_ramp: cross-field validation (rampInputSchema)', () => {
  test('rejects when neither color nor a full l/c/h triple is given, even with mode/steps set', () => {
    expect(rampInputSchema.safeParse({ mode: 'hue', steps: 5 }).success).toBe(false);
  });

  test('accepts color alone and fills in defaults for mode/steps/name', () => {
    const parsed = rampInputSchema.safeParse({ color: '#5b8cff' });
    expect(parsed.success).toBe(true);
    expect(parsed.data.mode).toBe('hue');
    expect(parsed.data.steps).toBe(9);
    expect(parsed.data.name).toBe('brand');
  });
});
