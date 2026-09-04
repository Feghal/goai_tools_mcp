'use strict';

const { calculateBmiAndBodyFat, inputSchema } = require('../controllers/tools/bmi-body-fat');

describe('calculateBmiAndBodyFat', () => {
  test('typical case: male, metric, matches the page defaults (178cm/78kg/38/88)', () => {
    // BMI = 78 / (1.78)^2 = 78 / 3.1684 = 24.6182... -> 24.6
    // h = 178/2.54 = 70.078740 in, n = 38/2.54 = 14.960630 in, w = 88/2.54 = 34.645669 in
    // w - n = 19.685039
    // fat = 86.010*log10(19.685039) - 70.041*log10(70.078740) + 36.76
    //     = 86.010*1.2941364   - 70.041*1.8455864          + 36.76
    //     = 111.30867          - 129.26672                 + 36.76
    //     = 18.80195...  -> clamp(2,75) -> round -> 19
    // lean = 78 * (1 - 19/100) = 78 * 0.81 = 63.18 -> 63.2
    const result = calculateBmiAndBodyFat({
      sex: 'male',
      units: 'metric',
      height: 178,
      weight: 78,
      neck: 38,
      waist: 88,
    });

    expect(result.bmi).toBeCloseTo(24.6, 5);
    expect(result.bmiCategory).toBe('Healthy range');
    expect(result.bodyFatPercent).toBe(19);
    expect(result.bodyFatRaw).toBeCloseTo(18.8, 1);
    expect(result.leanMass).toBeCloseTo(63.2, 5);
    expect(result.units).toBe('metric');
    expect(result.warnings).toEqual([]);
  });

  test('unit-conversion + clamp/range edge: waist barely above neck drives raw fat deeply negative, clamped to 2% with a range warning', () => {
    // w - n = 39 - 38 = 1cm -> 0.393701 in, log10 of that is negative, so
    // the raw formula output is far below the [2,75] floor. Confirmed by
    // direct computation: navyBodyFatRaw(...) === -127.32645700242111,
    // which is < 4 so the range warning must also fire.
    const result = calculateBmiAndBodyFat({
      sex: 'male',
      units: 'metric',
      height: 178,
      weight: 78,
      neck: 38,
      waist: 39,
    });

    expect(result.bodyFatRaw).toBeCloseTo(-127.33, 1);
    expect(result.bodyFatPercent).toBe(2); // clamped to the formula's floor
    // 78 * (1 - 2/100) = 76.44, rounded to 1 decimal -> 76.4
    expect(result.leanMass).toBeCloseTo(76.4, 5);
    expect(result.warnings).toContain(
      'Those numbers look outside the range the formula was fitted on, so treat the result with caution.'
    );
  });

  test('imperial units round-trip to the same raw body-fat value as the equivalent metric input', () => {
    // 178cm/38cm/88cm converted to inches directly (2.54 cm/in), fed as
    // already-imperial measurements, must reproduce the metric-path result
    // from the first test (18.80195307051995) exactly -- same formula, no
    // extra conversion applied when units === 'imperial'.
    const result = calculateBmiAndBodyFat({
      sex: 'male',
      units: 'imperial',
      height: 178 / 2.54,
      weight: 78,
      neck: 38 / 2.54,
      waist: 88 / 2.54,
    });

    expect(result.bodyFatRaw).toBeCloseTo(18.8, 1);
    expect(result.bodyFatPercent).toBe(19);
    expect(result.units).toBe('imperial');
  });

  test('impossible case: waist not exceeding neck returns null body-fat fields but keeps BMI, with the impossible-input warning', () => {
    const result = calculateBmiAndBodyFat({
      sex: 'male',
      units: 'metric',
      height: 178,
      weight: 78,
      neck: 40,
      waist: 38, // waist <= neck -> w - n <= 0 -> no formula answer
    });

    expect(result.bmi).toBeCloseTo(24.6, 5); // BMI is independent of neck/waist, still computed
    expect(result.bodyFatPercent).toBeNull();
    expect(result.bodyFatRaw).toBeNull();
    expect(result.leanMass).toBeNull();
    expect(result.warnings).toEqual([
      'Check the measurements: the waist has to be larger than the neck for the formula to have an answer.',
    ]);
  });

  test('female formula uses waist + hip - neck; a female input with hip present computes normally', () => {
    // h = 165/2.54 = 64.960630, n = 33/2.54 = 12.992126, w = 75/2.54 = 29.527559, p = 98/2.54 = 38.582677
    // w + p - n = 55.118110
    // fat = 163.205*log10(55.118110) - 97.684*log10(64.960630) - 78.387 -> 28.734014...
    // -> clamp/round -> 29%; lean = 65 * (1 - 0.29) = 46.15 -> rounds up to 46.2
    // (JS Math.round(461.5) = 462, i.e. round-half-up, same as the source's .toFixed(1))
    const result = calculateBmiAndBodyFat({
      sex: 'female',
      units: 'metric',
      height: 165,
      weight: 65,
      neck: 33,
      waist: 75,
      hip: 98,
    });

    expect(result.bodyFatPercent).toBe(29);
    expect(result.bodyFatRaw).toBeCloseTo(28.73, 1);
    expect(result.leanMass).toBeCloseTo(46.2, 5);
    expect(result.warnings).toEqual([]);
  });

  test('cross-field validation: the schema rejects a female input with no hip measurement', () => {
    const missingHip = inputSchema.safeParse({
      sex: 'female',
      units: 'metric',
      height: 165,
      weight: 65,
      neck: 33,
      waist: 75,
      // hip omitted
    });
    expect(missingHip.success).toBe(false);
    expect(missingHip.error.issues[0].path).toEqual(['hip']);
    expect(missingHip.error.issues[0].message).toBe("hip is required when sex is 'female'");

    // Same input, but male, does not need hip at all.
    const maleNoHip = inputSchema.safeParse({
      sex: 'male',
      units: 'metric',
      height: 178,
      weight: 78,
      neck: 38,
      waist: 88,
    });
    expect(maleNoHip.success).toBe(true);
  });
});
