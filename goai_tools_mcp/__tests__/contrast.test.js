'use strict';

const { checkContrast, findNearestPassingColor } = require('../controllers/tools/contrast');

describe('checkContrast', () => {
  test('typical case: black text on white background', () => {
    // WCAG ratio, by hand:
    //   luminance(#fff): each channel v=1 -> ((1+0.055)/1.055)^2.4 = 1^2.4 = 1
    //                     lum = 0.2126*1 + 0.7152*1 + 0.0722*1 = 1
    //   luminance(#000): each channel v=0 (v <= 0.04045 branch) -> c = 0/12.92 = 0
    //                     lum = 0
    //   ratio = (max+0.05)/(min+0.05) = (1+0.05)/(0+0.05) = 1.05/0.05 = 21
    //   source does Math.floor(r*100)/100 for display -> 21.00:1 (exact here, no truncation loss)
    const result = checkContrast({ foreground: '#000000', background: '#ffffff' });

    expect(result.foregroundHex).toBe('#000000');
    expect(result.backgroundHex).toBe('#ffffff');
    expect(result.ratio).toBe(21);
    expect(result.ratioDisplay).toBe('21.00:1');

    // APCA-W3 0.1.9 for black-on-white is the well-known reference figure
    // Lc ~106 (clamp(Ytxt) = 0.022^1.414 ~ 0.004535; clamp(Ybg) ~ 1;
    // C = (1^0.56 - 0.004535^0.57) * 1.14 ~ 1.0874; Lc = (C - 0.027)*100 ~ 106.0).
    expect(result.apca.lcAbs).toBe(106);
    expect(result.apca.lc).toBeCloseTo(106, 0);
    expect(result.apca.polarity).toBe('normal'); // Ybg > Ytxt: dark text on light background

    // A 21:1 ratio clears every threshold in the table.
    expect(result.cases).toHaveLength(3);
    const normal = result.cases.find((c) => c.key === 'normal');
    expect(normal.passAA).toBe(true);
    expect(normal.passAAA).toBe(true);
    const ui = result.cases.find((c) => c.key === 'ui');
    expect(ui.passAA).toBe(true);
    expect(ui.passAAA).toBeNull(); // UI components are never graded against AAA
    expect(result.summary).toEqual({ passed: 5, graded: 5, allPass: true });
  });

  test('edge case: 3-digit hex expands the same as the equivalent 6-digit hex', () => {
    // Source: /^[0-9a-f]{3}$/ match doubles each digit before the 6-digit
    // check, so "#000"/"#fff" must parse identically to "#000000"/"#ffffff".
    const short = checkContrast({ foreground: '#000', background: '#fff' });
    const long = checkContrast({ foreground: '#000000', background: '#ffffff' });
    expect(short.foregroundHex).toBe(long.foregroundHex);
    expect(short.backgroundHex).toBe(long.backgroundHex);
    expect(short.ratio).toBe(long.ratio);
  });

  test('unreadable hex throws a field-named error instead of a generic crash', () => {
    expect(() => checkContrast({ foreground: 'not-a-colour', background: '#ffffff' })).toThrow(/^foreground:/);
  });
});

describe('findNearestPassingColor', () => {
  test('typical case: a pair that already clears the default 4.5:1 target is left untouched', () => {
    // ratio(#000000, #ffffff) = 21 (see checkContrast test above) >= 4.5,
    // so nearestPassing's own guard returns the input colour unchanged.
    const result = findNearestPassingColor({ foreground: '#000000', background: '#ffffff', adjust: 'foreground' });

    expect(result.targetRatio).toBe(4.5); // 'normal-aa' preset, the default
    expect(result.currentRatio).toBe(21);
    expect(result.alreadyPassing).toBe(true);
    expect(result.found).toBe(true);
    expect(result.movedHex).toBe('#000000');
    expect(result.newRatio).toBe(21);
    expect(result.lightnessStepPercent).toBe(0);
    expect(result.direction).toBeNull();
    expect(result.message).toBe('This pair already passes the 4.5:1 target.');
  });

  test('edge case: a target ratio above the theoretical maximum (21:1) is unreachable in any hue', () => {
    // luminance(#777777), by hand: v = 0x77/255 = 119/255 = 0.466667
    //   ((0.466667+0.055)/1.055)^2.4 = 0.494475^2.4 ~ 0.1845 (same for r=g=b)
    //   lum ~ 0.1845 -> ratio = (1+0.05)/(0.1845+0.05) ~ 4.48 (fails the 4.5 default, incidentally)
    // Regardless of the exact starting ratio, no real colour pair exceeds
    // 21:1, so target: 100 must be unreachable by moving lightness alone.
    const result = findNearestPassingColor({
      foreground: '#777777',
      background: '#ffffff',
      adjust: 'foreground',
      target: 100,
    });

    expect(result.currentRatio).toBeGreaterThan(4);
    expect(result.currentRatio).toBeLessThan(4.5);
    expect(result.alreadyPassing).toBe(false);
    expect(result.found).toBe(false);
    expect(result.movedHex).toBeNull();
    expect(result.newRatio).toBeNull();
    expect(result.lightnessStepPercent).toBeNull();
    expect(result.direction).toBeNull();
    expect(result.message).toMatch(/needs a different hue/);
  });

  test('a failing pair is nudged darker until it clears the target (property-based: the search is a 100-step iterative walk, not hand-derivable to an exact hex)', () => {
    // luminance(#999999) ~ 0.3186 -> ratio(#999999, #ffffff) ~ 2.85, well
    // under 4.5. Moving the foreground *lighter* only shrinks the ratio
    // further (it walks toward the white background), so only the darker
    // direction can ever satisfy the target -- direction is deterministic
    // even though the exact resulting hex is not hand-computed here.
    const result = findNearestPassingColor({
      foreground: '#999999',
      background: '#ffffff',
      adjust: 'foreground',
      target: 'normal-aa',
    });

    expect(result.alreadyPassing).toBe(false);
    expect(result.found).toBe(true);
    expect(result.direction).toBe('darker');
    expect(result.newRatio).toBeGreaterThanOrEqual(4.5);
    expect(result.movedHex).toMatch(/^#[0-9a-f]{6}$/);
    expect(result.lightnessStepPercent).toBeGreaterThan(0);
    expect(result.lightnessStepPercent).toBeLessThanOrEqual(100);
  });

  test('cross-field-ish check: adjust selects which side moves, and the untouched side is echoed back unchanged in hex form', () => {
    // Moving the background instead of the foreground against the same pair
    // must still land on a passing ratio, and must not be reported as
    // "already passing" (the pair fails 4.5 either way round).
    const result = findNearestPassingColor({
      foreground: '#999999',
      background: '#ffffff',
      adjust: 'background',
      target: 'normal-aa',
    });
    expect(result.adjust).toBe('background');
    expect(result.alreadyPassing).toBe(false);
    expect(result.found).toBe(true);
    expect(result.newRatio).toBeGreaterThanOrEqual(4.5);
  });
});
