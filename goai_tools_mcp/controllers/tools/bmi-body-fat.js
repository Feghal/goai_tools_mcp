'use strict';

const { z } = require('zod');
const toolResult = require('../../utils/toolResult');
const toolAnnotations = require('../../utils/toolAnnotations');

// Ported from nginx/sites/goai/tools/body-fat.html's inline <script>. That
// page keeps its UI-facing copy in a JSON strings block (id="bf-strings");
// the two messages below are copied verbatim from it so this tool's
// `warnings` entries read exactly like the page's own warning banner.
const IMPOSSIBLE_MSG =
  'Check the measurements: the waist has to be larger than the neck for the formula to have an answer.';
const RANGE_MSG =
  'Those numbers look outside the range the formula was fitted on, so treat the result with caution.';

const CM_PER_IN = 2.54;

// The Navy circumference equations were fitted in inches, so metric
// measurements are converted to inches first rather than run through a
// re-derived metric variant -- mirrors the source's toInches().
function toInches(v, metric) {
  return metric ? v / CM_PER_IN : v;
}

// Exact port of the source's navyFat(). Returns null for the same
// "no answer" condition the page treats as impossible (waist, plus hip for
// the female formula, not exceeding neck) rather than throwing.
function navyBodyFatRaw(sex, height, neck, waist, hip, metric) {
  const h = toInches(height, metric);
  const n = toInches(neck, metric);
  const w = toInches(waist, metric);
  if (sex === 'female') {
    const p = toInches(hip, metric);
    if (w + p - n <= 0 || h <= 0) return null;
    return 163.205 * Math.log10(w + p - n) - 97.684 * Math.log10(h) - 78.387;
  }
  if (w - n <= 0 || h <= 0) return null;
  return 86.01 * Math.log10(w - n) - 70.041 * Math.log10(h) + 36.76;
}

// Exact port of the source's bmiOf(): metric is kg/m^2; imperial folds the
// 703 conversion constant into the same weight/height^2 ratio.
function bmiOf(weight, height, metric) {
  if (height <= 0) return null;
  return metric ? weight / Math.pow(height / 100, 2) : (703 * weight) / (height * height);
}

// Thresholds and labels match the source's classOf() exactly.
function classifyBmi(bmi) {
  if (bmi < 18.5) return 'Underweight';
  if (bmi < 25) return 'Healthy range';
  if (bmi < 30) return 'Overweight';
  return 'Obese';
}

function calculateBmiAndBodyFat(input) {
  const sex = input.sex;
  const metric = (input.units || 'metric') !== 'imperial';
  const { height, weight, neck, waist, hip } = input;

  // height/weight are z.number().positive() in the schema, so bmiOf() can
  // never actually return null here -- kept anyway as an exact port of the
  // source's own guard.
  const bmiValue = bmiOf(weight, height, metric);
  const bmi = bmiValue === null ? null : Math.round(bmiValue * 10) / 10;
  const bmiCategory = bmiValue === null ? null : classifyBmi(bmiValue);

  const warnings = [];
  const fatRaw = navyBodyFatRaw(sex, height, neck, waist, hip, metric);

  let bodyFatPercent = null;
  let bodyFatRaw = null;
  let leanMass = null;

  if (fatRaw === null || !isFinite(fatRaw)) {
    // Source: BMI stays on screen, but body fat/lean mass are blanked and
    // the warning banner takes over the status line. Mirrored here as a
    // successful result with the fat-side fields left null, rather than a
    // tool-level failure -- the BMI half of the answer is still valid.
    warnings.push(IMPOSSIBLE_MSG);
  } else {
    // "the tape method has no business reporting decimals" -- source clamps
    // to [2, 75] before rounding to a whole percent.
    bodyFatPercent = Math.round(Math.min(75, Math.max(2, fatRaw)));
    bodyFatRaw = Math.round(fatRaw * 100) / 100;
    leanMass = Math.round(weight * (1 - bodyFatPercent / 100) * 10) / 10;
    // Range warning uses the raw (pre-clamp) formula output, same as source.
    if (fatRaw < 4 || fatRaw > 60) warnings.push(RANGE_MSG);
  }

  return {
    bmi,
    bmiCategory,
    bodyFatPercent,
    bodyFatRaw,
    leanMass,
    // Not in the original hint's output shape, but leanMass's unit (kg vs
    // lb) is otherwise ambiguous to a caller that only sees the number.
    units: metric ? 'metric' : 'imperial',
    warnings,
  };
}

// Exported separately (alongside the pure calculator) so tests can exercise
// the cross-field "hip required for female" rule via .safeParse() without
// spinning up a real MCP server.
const inputSchema = z
  .object({
    sex: z.enum(['male', 'female']).describe('Sex, which selects the Navy formula variant.'),
    units: z
      .enum(['metric', 'imperial'])
      .default('metric')
      .describe('metric = cm/kg, imperial = inches/lb. Applies to every measurement below.'),
    // Upper bounds added here (the source page ships none): every field feeds
    // O(1) arithmetic so there is no DoS in an absurd value, but an unbounded
    // one just produces a confidently wrong answer from a log10 of a
    // meaningless number. These ceilings are loose enough to admit any real
    // person in either unit system.
    height: z.number().positive().max(300).describe('Height, in cm (metric) or inches (imperial).'),
    weight: z
      .number()
      .positive()
      .max(1500)
      .describe('Weight, in kg (metric) or lb (imperial). Used for BMI and lean mass, not for the body-fat percentage itself.'),
    neck: z.number().positive().max(300).describe('Neck circumference, just below the larynx, in cm or inches.'),
    waist: z
      .number()
      .positive()
      .max(500)
      .describe('Waist circumference (at the navel for men, at the narrowest point for women), in cm or inches.'),
    hip: z
      .number()
      .positive()
      .max(500)
      .optional()
      .describe("Hip circumference at the widest point, in cm or inches. Required when sex is 'female'; ignored for 'male'."),
  })
  .refine((v) => v.sex !== 'female' || v.hip !== undefined, {
    message: "hip is required when sex is 'female'",
    path: ['hip'],
  });

// The shape of the JSON in structuredContent. Declared so an agent can
// read the result without parsing prose -- and, because the SDK validates
// every success against it, so a handler that quietly stops returning a
// field fails here instead of downstream. Nullable fields below are the
// ones the computation genuinely leaves empty, not defensive padding.
const bmiOutputSchema = {
  bmi: z.number().nullable().describe('Body mass index to 1 decimal place, or null if it could not be computed.'),
  bmiCategory: z
    .string()
    .nullable()
    .describe("The WHO band that BMI falls in, e.g. 'Underweight', 'Normal', 'Overweight', 'Obese'. Null when bmi is null."),
  bodyFatPercent: z
    .number()
    .nullable()
    .describe('US Navy tape-method body fat as a whole percent, clamped to 2-75. Null when the measurements make the formula undefined (see warnings).'),
  bodyFatRaw: z
    .number()
    .nullable()
    .describe('The same figure before clamping and rounding, to 2 decimals -- this is the one that reveals an implausible measurement. Null in the same case as bodyFatPercent.'),
  leanMass: z
    .number()
    .nullable()
    .describe('Lean mass in the same unit system as the input (kg for metric, lb for imperial). Null when body fat could not be computed.'),
  units: z.enum(['metric', 'imperial']).describe("Which unit system leanMass is expressed in -- otherwise the bare number is ambiguous."),
  warnings: z
    .array(z.string())
    .describe('Plain-language cautions: the measurements make the formula undefined, or the result sits outside the range it was fitted on. Empty when neither applies.'),
};

function register(server) {
  server.registerTool(
    'calculate_bmi_and_body_fat',
    {
      title: 'BMI and Navy body fat calculator',
      description:
        "Computes BMI (with its standard weight-category label) and body fat percentage via the US Navy circumference method from height, weight, neck, waist, and (for females) hip measurements, plus the resulting lean body mass. The Navy equations are fitted in inches, so metric inputs are converted internally; the body-fat percentage is clamped to 2-75% and rounded to a whole number, matching GO AI's body-fat tool page exactly, including its 'waist must exceed neck (and hip, for the female formula)' impossible-input warning and its out-of-fitted-range caution for raw results below 4% or above 60%.",
      annotations: toolAnnotations.PURE,
      outputSchema: bmiOutputSchema,
      inputSchema,
    },
    async (args) => {
      try {
        const result = calculateBmiAndBodyFat(args);
        return toolResult.ok(result);
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );
}

module.exports = { register, toolCount: 1, calculateBmiAndBodyFat, navyBodyFatRaw, bmiOf, classifyBmi, inputSchema };
