'use strict';
const { z } = require('zod');
const toolResult = require('../../utils/toolResult');

// Ported from website_front/nginx/sites/goai/tools/tdee.html (client-side
// <script>). Every constant and rounding rule below is copied from that
// file's calc() function so this tool's numbers match the website's for the
// same input.

const round = (n) => Math.round(n);
const round1 = (n) => Math.round(n * 10) / 10; // matches the source's .toFixed(1) for lean mass

// value = the <select> option's numeric value in the HTML; label = that
// option's visible text verbatim (the source truncates this to the part
// before the em dash for the on-page headline, but the full text is more
// useful to a caller that never sees the <select>).
const ACTIVITY = {
  sedentary: { factor: 1.2, label: 'Sedentary — desk job, no exercise' },
  light: { factor: 1.375, label: 'Light — 1–3 sessions/week' },
  moderate: { factor: 1.55, label: 'Moderate — 3–5 sessions/week' },
  very_active: { factor: 1.725, label: 'Very active — 6–7 sessions/week' },
  extra_active: { factor: 1.9, label: 'Extra active — physical job or 2×/day' },
};

// Decimal fraction applied to TDEE, copied from the <select id="goal"> option values.
const GOAL_PCT = {
  lose_20: -0.2,
  lose_15: -0.15,
  maintain: 0,
  gain_10: 0.1,
};

const DISCLAIMER =
  'These are population-average formula estimates, not a measurement. Two people with identical stats can differ by 200-300 kcal/day through genetics, non-exercise activity and body composition. Use this as a starting point, then adjust after 2-3 weeks of real-world results.';

function computeTdee(input) {
  const units = input.units || 'metric';
  const male = input.sex === 'male';

  // Resolve to metric internally, exactly like the source's inputs():
  // 1 in = 2.54 cm (exact), 1 lb -> kg via division by 2.20462 (not the
  // rounded 0.4536 the page's own footnote quotes -- the actual JS divides
  // by 2.20462, and that's the number that must match, per rule 2).
  let heightCm;
  let weightKg;
  if (units === 'imperial') {
    heightCm = ((input.height_ft || 0) * 12 + (input.height_in || 0)) * 2.54;
    weightKg = input.weight_lb / 2.20462;
  } else {
    heightCm = input.height_cm;
    weightKg = input.weight_kg;
  }

  const age = input.age;

  // Mirrors the source's early-return guard in calc():
  //   if (!i.age || !i.h || !i.w || i.age < 14 || i.h < 100 || i.w < 25) return;
  // There the page just leaves the result blank; here it's a bad-input error.
  if (!age || age < 14 || !heightCm || heightCm < 100 || !weightKg || weightKg < 25) {
    throw new Error(
      'Inputs resolve to an out-of-range body: age must be >= 14, height >= 100 cm (~39 in), and weight >= 25 kg (~55 lb).'
    );
  }

  const mifflin = 10 * weightKg + 6.25 * heightCm - 5 * age + (male ? 5 : -161);
  const harris = male
    ? 88.362 + 13.397 * weightKg + 4.799 * heightCm - 5.677 * age
    : 447.593 + 9.247 * weightKg + 3.098 * heightCm - 4.33 * age;

  let katch = null;
  let lbm = null;
  const bf = input.body_fat_percent;
  if (typeof bf === 'number' && bf >= 3 && bf <= 60) {
    lbm = weightKg * (1 - bf / 100);
    katch = 370 + 21.6 * lbm;
  }

  const primaryIsKatch = katch !== null;
  const primary = primaryIsKatch ? katch : mifflin;
  const primaryName = primaryIsKatch ? 'Katch-McArdle' : 'Mifflin-St Jeor';

  const activity = ACTIVITY[input.activity_level];
  const act = activity.factor;
  const tdee = primary * act;

  const goalDecimal = GOAL_PCT[input.goal];
  const target = tdee * (1 + goalDecimal);
  const goalPct = goalDecimal * 100;
  const goalLabel =
    goalDecimal === 0
      ? 'maintenance'
      : goalDecimal < 0
      ? `${Math.abs(goalPct)}% deficit`
      : `${goalPct}% surplus`;

  const floor = male ? 1500 : 1200;
  const belowSafetyFloor = goalDecimal < 0 && target < floor;
  const safetyWarning = belowSafetyFloor
    ? `That target is below the usual floor (about ${male ? '1,500' : '1,200'} kcal/day for ${
        male ? 'men' : 'women'
      }). Sustained intake this low makes it hard to hit protein and micronutrient needs, and tends to backfire through muscle loss and rebound. Work with a professional rather than a calculator if you have a medical condition or are managing an eating disorder.`
    : null;

  const protein = 1.8 * weightKg;
  const fatKcal = target * 0.25;
  const fat = fatKcal / 9;
  const carbs = Math.max(0, (target - protein * 4 - fatKcal) / 4);

  const rows = [
    {
      formula: 'Mifflin-St Jeor',
      bmrRaw: mifflin,
      bestFor: 'Most people — the modern default',
    },
    {
      formula: 'Harris-Benedict',
      bmrRaw: harris,
      bestFor: 'Historical comparison; tends to read a little high',
    },
    {
      formula: 'Katch-McArdle',
      bmrRaw: katch,
      bestFor: primaryIsKatch
        ? "Uses your lean mass — the most accurate option when body fat % is known"
        : 'Needs a body fat % to compute',
    },
  ];

  const formulaComparison = rows.map((r) => ({
    formula: r.formula,
    bmr_kcal: r.bmrRaw === null ? null : round(r.bmrRaw),
    tdee_kcal: r.bmrRaw === null ? null : round(r.bmrRaw * act),
    best_for: r.bestFor,
    is_primary: r.formula === primaryName,
  }));

  const knownTdees = rows.filter((r) => r.bmrRaw !== null).map((r) => r.bmrRaw * act);
  const spreadKcal = round(Math.max.apply(null, knownTdees) - Math.min.apply(null, knownTdees));

  return {
    bmr: {
      mifflin_st_jeor: round(mifflin),
      harris_benedict: round(harris),
      katch_mcardle: katch === null ? null : round(katch),
    },
    lean_mass_kg: lbm === null ? null : round1(lbm),
    primary_formula: primaryName,
    activity_factor: act,
    activity_label: activity.label,
    tdee_kcal: round(tdee),
    goal_pct: goalPct,
    goal_label: goalLabel,
    goal_target_kcal: round(target),
    below_safety_floor: belowSafetyFloor,
    safety_floor_kcal: floor,
    safety_warning: safetyWarning,
    macros: {
      protein_g: round(protein),
      fat_g: round(fat),
      carbs_g: round(carbs),
    },
    formula_comparison: formulaComparison,
    spread_kcal: spreadKcal,
    resolved_inputs: { height_cm: round1(heightCm), weight_kg: round1(weightKg) },
    disclaimer: DISCLAIMER,
  };
}

const inputSchema = z
  .object({
    sex: z.enum(['male', 'female']),
    // The page's <input min=14 max=100>; the calc itself only ever enforces
    // the lower bound (see the guard in computeTdee), the upper bound is
    // just the site's own sane-input hint, kept here too.
    age: z.number().int().min(14).max(100),
    units: z.enum(['metric', 'imperial']).default('metric'),
    height_cm: z.number().min(50).max(272).optional(),
    height_ft: z.number().int().min(1).max(8).optional(),
    height_in: z.number().min(0).max(11).optional(),
    weight_kg: z.number().min(20).max(300).optional(),
    weight_lb: z.number().min(44).max(660).optional(),
    body_fat_percent: z
      .number()
      .min(3)
      .max(60)
      .optional()
      .describe('Optional. Unlocks the Katch-McArdle formula, which uses lean mass instead of total weight.'),
    activity_level: z.enum(['sedentary', 'light', 'moderate', 'very_active', 'extra_active']),
    goal: z.enum(['lose_20', 'lose_15', 'maintain', 'gain_10']),
  })
  .refine((v) => v.units !== 'metric' || v.height_cm !== undefined, {
    message: "height_cm is required when units is 'metric'",
    path: ['height_cm'],
  })
  .refine((v) => v.units !== 'metric' || v.weight_kg !== undefined, {
    message: "weight_kg is required when units is 'metric'",
    path: ['weight_kg'],
  })
  .refine((v) => v.units !== 'imperial' || v.height_ft !== undefined, {
    message: "height_ft is required when units is 'imperial'",
    path: ['height_ft'],
  })
  .refine((v) => v.units !== 'imperial' || v.weight_lb !== undefined, {
    message: "weight_lb is required when units is 'imperial'",
    path: ['weight_lb'],
  });

function register(server) {
  server.registerTool(
    'calculate_tdee',
    {
      title: 'TDEE & macro calculator',
      description:
        "Calculate Basal Metabolic Rate with Mifflin-St Jeor and Harris-Benedict (plus Katch-McArdle when body_fat_percent is given), then Total Daily Energy Expenditure, a goal-adjusted calorie target (cut/maintain/bulk), and a protein/fat/carb macro split, from sex, age, height, weight and activity level. These are population-average formulas, not a measurement of the person's actual metabolism -- real expenditure commonly varies 200-300 kcal from the estimate, and the result includes a warning flag when a deficit target falls below the usual safety floor.",
      inputSchema,
    },
    async (args) => {
      try {
        const result = computeTdee(args);
        return toolResult.ok(result);
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );
}

module.exports = { register, toolCount: 1, computeTdee };
