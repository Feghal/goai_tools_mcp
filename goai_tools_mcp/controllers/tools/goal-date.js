'use strict';

const { z } = require('zod');
const toolResult = require('../../utils/toolResult');
const toolAnnotations = require('../../utils/toolAnnotations');

// Ported from nginx/sites/goai/tools/goal-date.html's inline <script>. The
// page holds a fixed daily intake and recomputes Mifflin-St Jeor maintenance
// at each simulated day, so the deficit narrows on its own as weight falls
// -- unlike the naive "(kg to lose * 7700) / deficit" straight-line most
// goal-date calculators draw. Both answers are returned side by side, same
// as the page's chart.

const KCAL_PER_KG = 7700; // energy in a kilogram of body fat -- source's KCAL_PER_KG
const LB_PER_KG = 2.20462; // source's `LB`: lb = kg * LB, so kg = lb / LB
const CM_PER_IN = 2.54; // source's `IN_CM`

// The site's five <select> options for activity level, values taken
// verbatim from the <option value="..."> multipliers.
const ACTIVITY_MULTIPLIERS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  very_active: 1.725,
  extra_active: 1.9,
};

// Exact port of the source's bmr(): Mifflin-St Jeor.
function mifflinStJeorBmr(sex, weightKg, heightCm, age) {
  return 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === 'male' ? 5 : -161);
}

function roundTo1(n) {
  return Math.round(n * 10) / 10;
}

// Adds `days` (rounded) to an ISO "YYYY-MM-DD" reference date using UTC
// calendar arithmetic, so the result never shifts with the server's local
// timezone. The source instead formats `new Date()` + setDate() through
// toLocaleDateString(document.documentElement.lang) for on-page display;
// there is no "current locale" on the server side, so this returns a plain
// ISO date for the caller to format however it likes -- a deliberate
// deviation from the source's human-readable, locale-formatted string.
function addDaysIso(referenceDateStr, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(referenceDateStr || '');
  if (!m) {
    throw new Error(`referenceDate "${referenceDateStr}" is not a valid ISO date (YYYY-MM-DD)`);
  }
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (isNaN(date.getTime())) {
    throw new Error(`referenceDate "${referenceDateStr}" is not a valid calendar date`);
  }
  date.setUTCDate(date.getUTCDate() + Math.round(days));
  return date.toISOString().slice(0, 10);
}

// Pure projection logic. Takes the same raw, unit-tagged shape as the tool's
// inputSchema (mirrors bmi-body-fat.js / tdee.js: unit resolution happens
// inside the pure function, not in a separate conversion step) so tests can
// call it directly with no MCP server involved.
function computeGoalDateProjection(input) {
  const metric = (input.units || 'metric') !== 'imperial';

  const heightCm = metric ? input.heightCm : (input.heightFt * 12 + input.heightIn) * CM_PER_IN;
  if (!(heightCm > 0)) {
    // The schema requires heightCm (metric) or heightFt+heightIn (imperial)
    // individually, but not that feet/inches combine to something above
    // zero -- an explicit 0 ft / 0 in pair slips through. Same class of
    // schema-inexpressible combined guard as a recognized bad-input
    // condition, not a bug -- register()'s handler turns this into
    // toolResult.fail.
    throw new Error('height resolves to zero or less once feet/inches are combined');
  }

  const currentWeightKg = metric ? input.currentWeight : input.currentWeight / LB_PER_KG;
  const goalWeightKg = metric ? input.goalWeight : input.goalWeight / LB_PER_KG;

  const activityMultiplier = ACTIVITY_MULTIPLIERS[input.activityLevel];
  const maintenanceKcal = mifflinStJeorBmr(input.sex, currentWeightKg, heightCm, input.age) * activityMultiplier;
  const intakeKcal = maintenanceKcal - input.dailyDeficitKcal;
  const floorKcal = input.sex === 'male' ? 1500 : 1200;

  const base = {
    currentWeightKg: roundTo1(currentWeightKg),
    goalWeightKg: roundTo1(goalWeightKg),
    activityMultiplier,
    maintenanceKcal: Math.round(maintenanceKcal),
    intakeKcal: Math.round(intakeKcal),
    floorKcal,
  };

  if (intakeKcal < floorKcal) {
    // Source: project() returns { tooLow: true, intake } here without ever
    // computing settle/naiveDays/series -- mirrored by leaving every
    // field below null rather than inventing values the source never
    // derives for this branch.
    return {
      ...base,
      status: 'belowFloor',
      settleWeightKg: null,
      plateau: null,
      reachedWithinHorizon: false,
      horizonDays: null,
      daysToGoal: null,
      weeksToGoal: null,
      projectedDate: null,
      naiveDays: null,
      naiveWeeks: null,
      gapDays: null,
      series: null,
      naiveLineEndWeek: null,
      // Copied verbatim from the source's #floorWarn banner text.
      note:
        "That intake is below the usual floor. Sustained intakes under about 1,500 kcal (men) or 1,200 kcal (women) make it hard to hit protein and micronutrients, and tend to backfire through muscle loss and rebound, so no date is projected for one. A smaller deficit over a longer period is the better trade. If you have a medical condition or are managing an eating disorder, work with a professional rather than a calculator.",
    };
  }

  // Weight at which maintenance meets the fixed intake -- algebraic inverse
  // of mifflinStJeorBmr(sex, kg, heightCm, age) * activityMultiplier ===
  // intakeKcal. Exact port of the source's `settle`.
  const settleWeightKg =
    (intakeKcal / activityMultiplier - (6.25 * heightCm - 5 * input.age + (input.sex === 'male' ? 5 : -161))) / 10;

  // A goal at or below the settling weight is never reached however long you
  // wait -- the gap closes asymptotically. Source comment: "a loop would
  // just run out its horizon and report the wrong reason."
  const reachable = goalWeightKg > settleWeightKg;
  const horizonDays = reachable ? 365 * 5 : 365 * 2;

  let kg = currentWeightKg;
  let days = 0;
  const series = [kg];
  while (kg > goalWeightKg && days < horizonDays) {
    kg -= (mifflinStJeorBmr(input.sex, kg, heightCm, input.age) * activityMultiplier - intakeKcal) / KCAL_PER_KG;
    days++;
    if (days % 7 === 0) series.push(kg);
  }

  const reachedWithinHorizon = kg <= goalWeightKg;
  const naiveDays = ((currentWeightKg - goalWeightKg) * KCAL_PER_KG) / input.dailyDeficitKcal;
  const plateau = !reachable;
  const settleWeightKgRounded = roundTo1(settleWeightKg);

  const result = {
    ...base,
    status: reachedWithinHorizon ? 'reached' : plateau ? 'plateau' : 'notReachedWithinHorizon',
    settleWeightKg: settleWeightKgRounded,
    plateau,
    reachedWithinHorizon,
    horizonDays,
    naiveDays,
    // Not a value the source ever displays directly (only naiveDays feeds
    // the gap/chart math) -- added for symmetry with weeksToGoal so callers
    // don't have to do the /7 rounding themselves.
    naiveWeeks: Math.round(naiveDays / 7),
  };

  if (reachedWithinHorizon) {
    const gapDays = Math.round(days - naiveDays);
    result.daysToGoal = days;
    result.weeksToGoal = Math.round(days / 7);
    result.gapDays = gapDays;
    result.projectedDate = addDaysIso(input.referenceDate, days);
    // Source: gap >= 2 ? t('later', {n: gap}) : S.same -- copied verbatim.
    result.note =
      gapDays >= 2
        ? `The straight line puts it ${gapDays} days earlier than it will arrive.`
        : 'At this deficit the two answers are within a day of each other.';
  } else {
    result.daysToGoal = null;
    result.weeksToGoal = null;
    result.gapDays = null;
    result.projectedDate = null;
    // Source formats the settle weight via weight(), which switches between
    // kg/lb with the page's unit toggle; the API always reports kg, so the
    // note is fixed to kg regardless of the caller's input units -- a
    // deliberate deviation from the source's unit-following display text.
    result.note = plateau
      ? `At this intake your weight settles near ${settleWeightKgRounded.toFixed(1)} kg, which is above the goal. Reaching the goal means a larger deficit, not more time.`
      : 'Not reached within five years at this intake.';
  }

  if (input.includeChartSeries) {
    result.series = series.map((w, weekIndex) => ({ weekIndex, weightKg: roundTo1(w) }));
    // Where the straight naive line would cross the goal weight, in weeks
    // (uncapped -- the source only caps this for on-canvas pixel placement,
    // a rendering concern this API has no reason to replicate).
    result.naiveLineEndWeek = naiveDays / 7;
  } else {
    result.series = null;
    result.naiveLineEndWeek = null;
  }

  return result;
}

// The shape of the JSON in structuredContent. Declared so an agent can
// read the result without parsing prose -- and, because the SDK validates
// every success against it, so a handler that quietly stops returning a
// field fails here instead of downstream. Nullable fields below are the
// ones the computation genuinely leaves empty, not defensive padding.
const goalDateOutputSchema = {
  currentWeightKg: z.number().describe('Starting weight in kg, after any imperial conversion.'),
  goalWeightKg: z.number().describe('Target weight in kg, after any imperial conversion.'),
  activityMultiplier: z.number().describe('The multiplier the chosen activity level maps to.'),
  maintenanceKcal: z.number().describe('Maintenance calories at the starting weight.'),
  intakeKcal: z.number().describe('Daily intake implied by the requested deficit, after the safety floor is applied.'),
  floorKcal: z.number().describe('The intake floor that was enforced, below which the projection is not modelled.'),
  status: z
    .string()
    .describe('How the projection ended: the goal is reached, or it settles short of the goal, or it is unreachable at this intake. The field to branch on before reading the dates.'),
  settleWeightKg: z
    .number()
    .nullable()
    .describe('The weight this intake eventually settles at, since maintenance falls as weight does. Null when it does not apply.'),
  plateau: z
    .boolean()
    .nullable()
    .describe('True when the settle weight is above the goal, i.e. this deficit alone will never get there. Null when it does not apply.'),
  reachedWithinHorizon: z.boolean().describe('Whether the goal is reached inside the modelled horizon.'),
  horizonDays: z.number().nullable().describe('Length of the modelled horizon in days, or null when not modelled.'),
  naiveDays: z
    .number()
    .nullable()
    .describe('Days predicted by the flat 7,700 kcal-per-kg rule that ignores the falling maintenance -- the figure most calculators stop at.'),
  naiveWeeks: z.number().nullable().describe('The same figure in whole weeks.'),
  daysToGoal: z.number().nullable().describe('Days to the goal under the adaptive model, or null when the goal is never reached.'),
  weeksToGoal: z.number().nullable().describe('The same figure in whole weeks.'),
  gapDays: z
    .number()
    .nullable()
    .describe('How many days longer the honest answer is than the naive one -- the whole point of the tool. Null when the goal is never reached.'),
  projectedDate: z.string().nullable().describe('Calendar date the goal is reached, ISO YYYY-MM-DD, or null when it is not reached.'),
  note: z.string().describe('Plain-language reading of the result, including why the two answers differ or why the goal is unreachable.'),
  series: z
    .array(
      z.object({
        weekIndex: z.number().int().describe('Weeks from the reference date.'),
        weightKg: z.number().describe('Projected weight at that week under the adaptive model.'),
      })
    )
    .nullable()
    .describe('Weekly projection points for plotting. Null when includeChartSeries was false.'),
  naiveLineEndWeek: z
    .number()
    .nullable()
    .describe('Where the naive straight line would end on the same axes, so the two can be drawn together. Null when there is no series.'),
};

function register(server) {
  server.registerTool(
    'project_weight_goal_date',
    {
      title: 'Weight loss goal-date projector',
      description:
        "Projects the calendar date a goal body weight is reached under a fixed daily calorie intake. Unlike a naive straight-line calculator (kg to lose x 7700 / deficit, also returned here for comparison), this recomputes Mifflin-St Jeor maintenance calories at each simulated day as weight falls, so the effective deficit narrows the way it really does -- meaning the projected date is later than, or equal to, the naive one, never earlier. Refuses to project a date when the resulting intake falls below a 1500 kcal (men) / 1200 kcal (women) floor, and reports a 'plateau' outcome instead of a date when the goal sits at or below the weight where maintenance would settle at that intake (an asymptote that a fixed intake alone can never cross). Adult-only inputs (18+); only projects weight loss (goalWeight must be less than currentWeight).",
      annotations: toolAnnotations.PURE,
      outputSchema: goalDateOutputSchema,
      inputSchema: z
        .object({
          sex: z.enum(['male', 'female']).describe('Biological sex, used by the Mifflin-St Jeor formula.'),
          // Upper bounds added here (the source page ships none on this
          // field): the day-by-day simulation loop below is already bounded
          // by horizonDays, but an absurd age/weight makes every intermediate
          // a meaningless number that still costs the same 1825 iterations to
          // produce, and reports a settle weight of -1e300. 120 matches the
          // sibling calculators' own sane-input ceilings (see tdee.js).
          age: z.number().min(18).max(120).describe('Age in years, 18-120. The source page is not validated for children; 18+ only.'),
          units: z
            .enum(['metric', 'imperial'])
            .default('metric')
            .describe('metric = cm/kg, imperial = ft+in/lb. Applies to height and both weight fields.'),
          heightCm: z.number().positive().max(300).optional().describe("Height in centimeters. Required when units is 'metric'."),
          heightFt: z.number().nonnegative().max(9).optional().describe("Feet part of height. Required when units is 'imperial'."),
          heightIn: z
            .number()
            .nonnegative()
            .max(11)
            .optional()
            .describe("Inches part of height (0-11). Required when units is 'imperial'."),
          currentWeight: z.number().positive().max(1500).describe('Current body weight, kg if units is metric, lb if imperial.'),
          goalWeight: z
            .number()
            .positive()
            .max(1500)
            .describe(
              'Goal body weight, same unit as currentWeight. Must be less than currentWeight -- this tool only projects weight loss, matching the source page.'
            ),
          activityLevel: z
            .enum(['sedentary', 'light', 'moderate', 'very_active', 'extra_active'])
            .describe(
              "Activity multiplier bucket, the site's five options: sedentary x1.2 (desk job, no exercise), light x1.375 (1-3 sessions/week), moderate x1.55 (3-5 sessions/week, the site default), very_active x1.725 (6-7 sessions/week), extra_active x1.9 (physical job or 2x/day training)."
            ),
          dailyDeficitKcal: z
            .number()
            .positive()
            .max(10000)
            .describe(
              "Daily calorie deficit to hold against today's computed maintenance. The site's quick picks are 250/500/750/1000 kcal, but any positive number is accepted."
            ),
          referenceDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, 'referenceDate must be an ISO date in YYYY-MM-DD form')
            .optional()
            .describe('ISO date (YYYY-MM-DD) the projection counts forward from. Defaults to today (UTC) when omitted.'),
          includeChartSeries: z
            .boolean()
            .default(true)
            .describe(
              'If true, also return the weekly weight series and the naive straight-line end week -- the same two lines the source page charts. Set false to skip them for a lighter response.'
            ),
        })
        .refine((v) => v.units !== 'metric' || v.heightCm !== undefined, {
          message: "heightCm is required when units is 'metric'",
          path: ['heightCm'],
        })
        .refine((v) => v.units !== 'imperial' || (v.heightFt !== undefined && v.heightIn !== undefined), {
          message: "heightFt and heightIn are required when units is 'imperial'",
          path: ['heightFt'],
        })
        .refine((v) => v.goalWeight < v.currentWeight, {
          message: 'goalWeight must be less than currentWeight -- this tool only projects weight loss',
          path: ['goalWeight'],
        }),
    },
    async (args) => {
      try {
        const referenceDate = args.referenceDate || new Date().toISOString().slice(0, 10);
        const result = computeGoalDateProjection({ ...args, referenceDate });
        return toolResult.ok(result);
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );
}

module.exports = { register, toolCount: 1, computeGoalDateProjection, mifflinStJeorBmr, addDaysIso };
