'use strict';

const toolPath = require.resolve('../controllers/tools/tdee');
const { computeTdee } = require(toolPath);

// The cross-field unit requirement lives in the zod schema passed to
// server.registerTool, not in computeTdee itself (which trusts its caller
// already resolved units). Re-derive it the same way register() does, by
// invoking register() against a stub server and capturing what it registers.
function getRegisteredSchema() {
  let captured = null;
  const stubServer = {
    registerTool(name, config) {
      captured = config.inputSchema;
    },
  };
  require(toolPath).register(stubServer);
  return captured;
}

describe('computeTdee', () => {
  test('typical case: metric, male, no body fat (matches the tool page defaults)', () => {
    // Mirrors the exact default values pre-filled on the tdee.html page:
    // sex=male, age=30, height=178cm, weight=78kg, activity=moderate (1.55),
    // goal=lose_15 (-0.15).
    //
    // mifflin = 10*78 + 6.25*178 - 5*30 + 5
    //         = 780 + 1112.5 - 150 + 5 = 1747.5
    // harris  = 88.362 + 13.397*78 + 4.799*178 - 5.677*30
    //         = 88.362 + 1044.966 + 854.222 - 170.31 = 1817.24
    // tdee    = 1747.5 * 1.55 = 2708.625            -> round 2709
    // target  = 2708.625 * (1 - 0.15) = 2302.33125  -> round 2302
    // protein = 1.8 * 78 = 140.4                    -> round 140
    // fatKcal = 2302.33125 * 0.25 = 575.5828125
    // fat     = 575.5828125 / 9 = 63.95...           -> round 64
    // carbs   = (2302.33125 - 140.4*4 - 575.5828125) / 4
    //         = (2302.33125 - 561.6 - 575.5828125) / 4 = 291.287...  -> round 291
    // harris tdee = 1817.24 * 1.55 = 2816.722         -> round 2817
    // spread  = round(2816.722 - 2708.625) = round(108.097) = 108
    const result = computeTdee({
      sex: 'male',
      age: 30,
      units: 'metric',
      height_cm: 178,
      weight_kg: 78,
      activity_level: 'moderate',
      goal: 'lose_15',
    });

    expect(result.bmr.mifflin_st_jeor).toBe(1748); // Math.round(1747.5) rounds .5 up
    expect(result.bmr.harris_benedict).toBe(1817);
    expect(result.bmr.katch_mcardle).toBeNull();
    expect(result.lean_mass_kg).toBeNull();
    expect(result.primary_formula).toBe('Mifflin-St Jeor');
    expect(result.activity_factor).toBe(1.55);
    expect(result.tdee_kcal).toBe(2709);
    expect(result.goal_pct).toBe(-15);
    expect(result.goal_label).toBe('15% deficit');
    expect(result.goal_target_kcal).toBe(2302);
    expect(result.below_safety_floor).toBe(false);
    expect(result.safety_floor_kcal).toBe(1500);
    expect(result.safety_warning).toBeNull();
    expect(result.macros).toEqual({ protein_g: 140, fat_g: 64, carbs_g: 291 });
    expect(result.spread_kcal).toBe(108);

    const mifflinRow = result.formula_comparison.find((r) => r.formula === 'Mifflin-St Jeor');
    expect(mifflinRow.is_primary).toBe(true);
    expect(mifflinRow.tdee_kcal).toBe(2709);
    const harrisRow = result.formula_comparison.find((r) => r.formula === 'Harris-Benedict');
    expect(harrisRow.bmr_kcal).toBe(1817);
    expect(harrisRow.tdee_kcal).toBe(2817);
    const katchRow = result.formula_comparison.find((r) => r.formula === 'Katch-McArdle');
    expect(katchRow.bmr_kcal).toBeNull();
    expect(katchRow.is_primary).toBe(false);
  });

  test('edge case: imperial units + body fat % switches primary to Katch-McArdle, and exercises the unit conversion', () => {
    // height = 5 ft 4 in -> (5*12+4) * 2.54 = 64 * 2.54 = 162.56 cm
    // weight = 130 lb -> 130 / 2.20462 = 58.96707822663317 kg  (source's exact
    //   divisor -- NOT the 0.4536 the page's own footnote text quotes)
    // lbm    = 58.96707822663317 * (1 - 25/100) = 44.22530866997488 -> round1 44.2
    // katch  = 370 + 21.6 * 44.22530866997488 = 1325.2666672714574 -> round 1325
    // mifflin= 10*58.967... + 6.25*162.56 - 5*25 - 161 = 1319.6707822663316 -> round 1320
    // harris = 447.593 + 9.247*58.967... + 3.098*162.56 - 4.330*25 = 1388.222452361677 -> round 1388
    // primary (katch, since bf given) * activity(sedentary=1.2) = 1325.2666672714574*1.2
    //        = 1590.320000725749 -> round 1590
    // target = 1590.320000725749 * (1 - 0.20) = 1272.2560005805992 -> round 1272
    const result = computeTdee({
      sex: 'female',
      age: 25,
      units: 'imperial',
      height_ft: 5,
      height_in: 4,
      weight_lb: 130,
      body_fat_percent: 25,
      activity_level: 'sedentary',
      goal: 'lose_20',
    });

    // resolved_inputs is rounded to 1 decimal (round1), same as the source's .toFixed(1):
    // 162.56 -> 162.6, 58.967... -> 59.0
    expect(result.resolved_inputs.height_cm).toBe(162.6);
    expect(result.resolved_inputs.weight_kg).toBe(59);
    expect(result.lean_mass_kg).toBe(44.2);
    expect(result.bmr.katch_mcardle).toBe(1325);
    expect(result.bmr.mifflin_st_jeor).toBe(1320);
    expect(result.bmr.harris_benedict).toBe(1388);
    expect(result.primary_formula).toBe('Katch-McArdle');
    expect(result.tdee_kcal).toBe(1590);
    expect(result.goal_target_kcal).toBe(1272);
    expect(result.below_safety_floor).toBe(false); // 1272 > 1200 floor for women

    const katchRow = result.formula_comparison.find((r) => r.formula === 'Katch-McArdle');
    expect(katchRow.is_primary).toBe(true);
  });

  test('below-safety-floor flag flips true for a large deficit on a small frame', () => {
    // mifflin = 10*50 + 6.25*160 - 5*30 - 161 = 500 + 1000 - 150 - 161 = 1189
    // tdee    = 1189 * 1.2 (sedentary) = 1426.8
    // target  = 1426.8 * (1 - 0.20) = 1141.44 -> round 1141, below the 1200 floor for women
    const result = computeTdee({
      sex: 'female',
      age: 30,
      units: 'metric',
      height_cm: 160,
      weight_kg: 50,
      activity_level: 'sedentary',
      goal: 'lose_20',
    });

    expect(result.goal_target_kcal).toBe(1141);
    expect(result.safety_floor_kcal).toBe(1200);
    expect(result.below_safety_floor).toBe(true);
    expect(result.safety_warning).toEqual(expect.stringContaining('1,200'));
  });

  test('out-of-range resolved body (documented guard in the source) throws instead of silently computing', () => {
    // Source: `if (!i.age || !i.h || !i.w || i.age < 14 || i.h < 100 || i.w < 25) return;`
    // A 3 ft 0 in height resolves to 3*12*2.54 = 91.44 cm, under the 100 cm floor.
    expect(() =>
      computeTdee({
        sex: 'male',
        age: 30,
        units: 'imperial',
        height_ft: 3,
        height_in: 0,
        weight_lb: 150,
        activity_level: 'moderate',
        goal: 'maintain',
      })
    ).toThrow(/out-of-range/);
  });

  test('cross-field validation: units=imperial without height_ft/weight_lb is rejected by the schema', () => {
    const schema = getRegisteredSchema();

    const missingImperialFields = schema.safeParse({
      sex: 'male',
      age: 40,
      units: 'imperial',
      // height_ft / weight_lb omitted -- required only because units is imperial
      activity_level: 'light',
      goal: 'maintain',
    });
    expect(missingImperialFields.success).toBe(false);

    const validImperial = schema.safeParse({
      sex: 'male',
      age: 40,
      units: 'imperial',
      height_ft: 5,
      height_in: 10,
      weight_lb: 180,
      activity_level: 'light',
      goal: 'maintain',
    });
    expect(validImperial.success).toBe(true);

    // Same shape, but units defaults to metric -- so height_cm/weight_kg (not
    // supplied here) are the ones that should now be flagged as missing.
    const missingMetricFields = schema.safeParse({
      sex: 'male',
      age: 40,
      height_ft: 5,
      height_in: 10,
      weight_lb: 180,
      activity_level: 'light',
      goal: 'maintain',
    });
    expect(missingMetricFields.success).toBe(false);
  });
});
