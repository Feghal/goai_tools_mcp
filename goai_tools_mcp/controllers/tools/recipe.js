'use strict';

const { z } = require('zod');
const toolResult = require('../../utils/toolResult');

// Ported line-for-line from nginx/sites/goai/tools/recipe.html's inline
// <script>, plus the two JSON <script type="application/json"> blocks it
// reads at startup (#recipe-data, #recipe-strings). Only the English
// strings needed by these two tools' *output* are carried over -- the
// source's i18n plumbing (translated unit/variant labels used only to
// build its <select> options and its localized unit-word matcher) is not,
// since an English unit token and its English label are the same string
// there, so nothing is lost by using the token directly. Anywhere this
// file's behaviour differs from the source it is called out at the point
// of difference.

// The cup weight in #recipe-data is always "grams in one US customary
// cup" -- density() below divides by this fixed constant regardless of
// which cup size the caller selects for volume math. That is a source
// behaviour worth flagging explicitly: CUSTOMARY_CUP_ML is NOT the same
// value as the cupSizeMl the tools accept (which only scales 'cup' and,
// for ingredients without their own USDA spoon weight, 'tbsp'/'tsp').
const CUSTOMARY_CUP_ML = 236.588;
const OZ_TO_G = 28.349523125;

// Verbatim transcription of #recipe-data. `derived`/`tspExact` are only
// set on baking powder, baking soda and yeast, whose USDA entries publish
// a spoon weight directly rather than a cup weight the tool would
// otherwise have to divide by 48/16 -- see toGrams() below.
const DATA = {
  'flour-ap': { fdc: 168894, cup: 125, variants: { '': '' } },
  'flour-bread': { fdc: 168896, cup: 137, variants: { '': '' } },
  'flour-cake': { fdc: 169723, cup: 137, variants: { dipped: '' } },
  'flour-ww': { fdc: 168893, cup: 120, variants: { '': '' } },
  cornstarch: { fdc: 169698, cup: 128, variants: { '': '' } },
  'sugar-white': { fdc: 169655, cup: 200, variants: { '': '' } },
  'sugar-brown': { fdc: 168833, cup: 220, variants: { packed: 220, loose: 145 } },
  'sugar-icing': { fdc: 169656, cup: 120, variants: { unsifted: 120, sifted: 100 } },
  cocoa: { fdc: 169593, cup: 86, variants: { '': '' } },
  butter: { fdc: 173410, cup: 227, variants: { '': '' } },
  'oil-olive': { fdc: 171413, cup: 216, variants: { '': '' } },
  'oil-canola': { fdc: 172336, cup: 218, variants: { '': '' } },
  milk: { fdc: 171265, cup: 244, variants: { '': '' } },
  buttermilk: { fdc: 172225, cup: 245, variants: { '': '' } },
  cream: { fdc: 170859, cup: 238, variants: { '': '' } },
  sourcream: { fdc: 171257, cup: 230, variants: { '': '' } },
  creamcheese: { fdc: 173418, cup: 232, variants: { '': '' } },
  yogurt: { fdc: 171284, cup: 245, variants: { '': '' } },
  water: { fdc: 174158, cup: 237, variants: { '': '' } },
  egg: { fdc: 171287, cup: 243, variants: { '': '' } },
  honey: { fdc: 169640, cup: 339, variants: { '': '' } },
  maple: { fdc: 169661, cup: 315, variants: { '': '' } },
  molasses: { fdc: 168820, cup: 337, variants: { '': '' } },
  peanutbutter: { fdc: 174266, cup: 258, variants: { '': '' } },
  salt: { fdc: 173468, cup: 292, variants: { '': '' } },
  bakingpowder: { fdc: 172803, cup: 221, derived: 1, tspExact: 4.6, variants: { '': '' } },
  bakingsoda: { fdc: 175040, cup: 221, derived: 1, tspExact: 4.6, variants: { '': '' } },
  yeast: { fdc: 175043, cup: 192, derived: 1, tspExact: 4, variants: { '': '' } },
  oats: { fdc: 173904, cup: 81, variants: { '': '' } },
  rice: { fdc: 169756, cup: 185, variants: { '': '' } },
  almonds: { fdc: 170567, cup: 143, variants: { whole: 143, sliced: 92, slivered: 108, ground: 95 } },
  walnuts: { fdc: 170187, cup: 117, variants: { chopped: 117, halves: 100, ground: 80 } },
  pecans: { fdc: 170182, cup: 109, variants: { chopped: 109, halves: 99 } },
  raisins: { fdc: 168165, cup: 145, variants: { loose: 145, packed: 165 } },
  chocchips: { fdc: 167976, cup: 182, variants: { regular: 182, mini: 173 } },
  parmesan: { fdc: 171247, cup: 100, variants: { '': '' } },
};

// English display names, from #recipe-strings -- only the ingredient-name
// keys are needed (see file header re: i18n plumbing left behind).
const NAMES = {
  'flour-ap': 'All-purpose flour',
  'flour-bread': 'Bread flour',
  'flour-cake': 'Cake flour',
  'flour-ww': 'Whole wheat flour',
  cornstarch: 'Cornstarch',
  'sugar-white': 'Granulated sugar',
  'sugar-brown': 'Brown sugar',
  'sugar-icing': 'Powdered sugar',
  cocoa: 'Cocoa powder, unsweetened',
  butter: 'Butter',
  'oil-olive': 'Olive oil',
  'oil-canola': 'Canola oil',
  milk: 'Whole milk',
  buttermilk: 'Buttermilk',
  cream: 'Heavy cream',
  sourcream: 'Sour cream',
  creamcheese: 'Cream cheese',
  yogurt: 'Plain yoghurt',
  water: 'Water',
  egg: 'Egg, beaten',
  honey: 'Honey',
  maple: 'Maple syrup',
  molasses: 'Molasses',
  peanutbutter: 'Peanut butter',
  salt: 'Table salt',
  bakingpowder: 'Baking powder',
  bakingsoda: 'Baking soda',
  yeast: 'Active dry yeast',
  oats: 'Rolled oats, dry',
  rice: 'White rice, raw',
  almonds: 'Almonds',
  walnuts: 'Walnuts',
  pecans: 'Pecans',
  raisins: 'Raisins',
  chocchips: 'Chocolate chips',
  parmesan: 'Parmesan, grated',
};

const INGREDIENT_IDS = Object.keys(DATA);
const UNITS = ['cup', 'tbsp', 'tsp', 'ml', 'g', 'oz'];

// findIngredientKey() runs 36 indexOf scans plus a lowercase copy over EVERY
// line, so per-call cost is lines x lineLength x 36. Both halves are bounded
// rather than just the total: a recipe is tens of short lines.
// (The line regex itself was checked for catastrophic backtracking -- the
// `[\d\s/.,]+` / `\s*` / `\s+` overlap is a classic ambiguity -- and measured
// flat at 32K characters of pathological input, so length is the only cost.)
const MAX_LINES = 500;
const MAX_LINE_CHARS = 1000;

const BAD_AMOUNT_MSG = 'Enter an amount, as a decimal or a fraction like 1 1/2.';
const WATER_SAME_MSG = 'This one is close to water, so most converters get it right.';
function waterFmt(n, pct) {
  return `A water-based converter would say ${n} g — off by ${pct}%.`;
}

// Exact port of parseAmount(): "1 1/2", "3/4", ".75", "2". Note .replace(',', '.')
// only swaps the FIRST comma (source used the string form, not /,/g).
function parseAmount(text) {
  const s = String(text).trim().replace(',', '.');
  if (!s) return NaN;
  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = s.match(/^(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) / Number(m[2]);
  const n = Number(s);
  return isFinite(n) ? n : NaN;
}

// Exact port of round(): note the thresholds are on the *value itself*,
// not its magnitude, so this misbehaves the same way the source does for
// negative numbers (falls through to the 2-decimal branch). Not guarded
// against here, to stay an exact port.
function round(n) {
  if (n >= 100) return Math.round(n);
  if (n >= 10) return Math.round(n * 10) / 10;
  return Math.round(n * 100) / 100;
}

// Exact port of fraction(): nearest eighth/third/etc within 0.04, else a
// plain rounded decimal string.
function fraction(n) {
  const whole = Math.floor(n + 1e-9);
  const rest = n - whole;
  let best = null;
  [[1, 8], [1, 4], [1, 3], [3, 8], [1, 2], [5, 8], [2, 3], [3, 4], [7, 8]].forEach((f) => {
    const d = Math.abs(rest - f[0] / f[1]);
    if (d < 0.04 && (!best || d < best[2])) best = [f[0], f[1], d];
  });
  if (rest < 0.04) return String(whole);
  if (!best) return String(round(n));
  return (whole ? whole + ' ' : '') + best[0] + '/' + best[1];
}

// Exact port of variantsOf(): the non-empty keys of an ingredient's
// `variants` map, i.e. the measurement styles it actually offers
// (regardless of whether each one carries a distinct numeric weight --
// flour-cake's "dipped" is a real, selectable style whose value is ''
// because it doesn't change the number, only what it means).
function variantsOf(key) {
  return Object.keys(DATA[key].variants).filter((v) => v !== '');
}

// Exact port of density(): grams per millilitre, always derived from the
// fixed customary cup -- see the CUSTOMARY_CUP_ML comment above.
function density(row, variant) {
  let base = row.cup;
  if (variant && typeof row.variants[variant] === 'number') base = row.variants[variant];
  return base / CUSTOMARY_CUP_ML;
}

// Exact port of toGrams(): a teaspoon/tablespoon of a fine powder is not
// exactly a cup divided by 48/16 -- USDA publishes its own spoon weight
// for the three leaveners (tspExact), so that is used instead whenever
// it's present, independent of the caller's chosen cup size.
function toGrams(row, dens, n, unit, cupMl) {
  if (unit === 'g') return n;
  if (unit === 'oz') return n * OZ_TO_G;
  if (unit === 'ml') return n * dens;
  if (unit === 'cup') return n * cupMl * dens;
  if (unit === 'tsp') return row.tspExact ? n * row.tspExact : n * (cupMl / 48) * dens;
  if (unit === 'tbsp') return row.tspExact ? n * row.tspExact * 3 : n * (cupMl / 16) * dens;
  return NaN;
}

// --- Tool 1: recipe_convert_ingredient -------------------------------------

function computeIngredientConversion(input) {
  const { ingredient, variant, unit } = input;
  const cupMl = input.cupSizeMl == null ? CUSTOMARY_CUP_ML : input.cupSizeMl;
  const n = parseAmount(input.amount);
  // Source: render() blanks every field and shows S.badAmount when the
  // amount doesn't parse. Nothing else in this tool can be computed
  // without n, so this is the "recognized bad input, not a bug" case --
  // thrown here and turned into toolResult.fail() by register() below,
  // same as contrast.js's badHexError().
  if (!isFinite(n)) throw new Error(BAD_AMOUNT_MSG);

  const row = DATA[ingredient];
  const dens = density(row, variant);
  const grams = toGrams(row, dens, n, unit, cupMl);
  const ounces = grams / OZ_TO_G;
  const name = NAMES[ingredient] || ingredient;

  const workSentence = `${String(input.amount).trim()} ${unit} of ${name} = ${round(grams)} g`;

  // Source: the water-comparison note is left blank when the unit is
  // already a weight (converting g/oz to g/oz says nothing about
  // density), or when either side of the comparison isn't a usable
  // finite/non-zero number.
  let waterComparison = '';
  if (unit !== 'g' && unit !== 'oz') {
    const waterRow = DATA.water;
    const waterDens = density(waterRow, undefined);
    const water = toGrams(waterRow, waterDens, n, unit, cupMl);
    if (isFinite(water) && grams) {
      const pct = Math.round((Math.abs(water - grams) / grams) * 100);
      waterComparison = pct < 5 ? WATER_SAME_MSG : waterFmt(round(water), pct);
    }
  }

  return {
    grams,
    gramsRounded: round(grams),
    ounces,
    ouncesRounded: round(ounces),
    densityGPerMl: dens,
    densityGPerMlRounded: round(dens),
    workSentence,
    waterComparison,
  };
}

// Cross-field rule the plain enum/string fields can't express on their
// own: which `variant` strings are valid depends on which `ingredient`
// was picked. The source never hits this case -- its <select> only ever
// offers variants belonging to the currently-chosen ingredient -- but an
// API caller can send any combination, and density()'s own fallback
// (silently ignore an unrecognised variant and use the base cup weight)
// would let a typo pass through as a silently-wrong density. Rejecting it
// here instead is a deliberate behaviour addition for this API surface,
// not a port of anything the page itself does.
const ingredientInputSchema = z
  .object({
    ingredient: z.enum(INGREDIENT_IDS).describe('Which ingredient to convert, identified by its GO AI recipe-tool id (e.g. "flour-ap", "sugar-brown", "honey").'),
    variant: z
      .string()
      // Echoed into the superRefine error message when unrecognised.
      .max(64)
      .optional()
      .describe(
        'Measurement style for ingredients that have more than one USDA figure (e.g. sugar-brown: "packed"/"loose"; sugar-icing: "unsifted"/"sifted"; almonds: "whole"/"sliced"/"slivered"/"ground"). Omit for ingredients with only one style.'
      ),
    // Echoed verbatim into workSentence; a number is never long.
    amount: z.string().min(1).max(64).describe('Amount as a decimal ("1.5"), a simple fraction ("3/4"), or a mixed number ("1 1/2").'),
    unit: z.enum(UNITS).describe('Unit the amount is given in.'),
    cupSizeMl: z
      .number()
      .positive()
      .optional()
      .default(CUSTOMARY_CUP_ML)
      .describe(
        "Cup size in ml, for the 'cup' unit (and 'tbsp'/'tsp' on ingredients without their own USDA spoon weight). Defaults to the US customary cup (236.588 ml); other common values are 240 (US nutrition-label cup) or 250 (metric cup). Does not affect the reported density, which is always derived from the customary cup regardless of this value, matching the source tool."
      ),
  })
  .superRefine((val, ctx) => {
    if (val.variant === undefined) return;
    const valid = variantsOf(val.ingredient);
    if (!valid.includes(val.variant)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['variant'],
        message: valid.length
          ? `'${val.variant}' is not a measurement style for '${val.ingredient}'. Valid values: ${valid.join(', ')}.`
          : `'${val.ingredient}' has only one measurement style, so 'variant' should be omitted.`,
      });
    }
  });

// --- Tool 2: recipe_scale ---------------------------------------------------

// English-only port of the source's i18n-aware unit-word map. The source
// also indexes translated unit labels so a pasted recipe in the reader's
// own language still parses; since these tools work in English text only,
// and an English unit label equals its own token (S['u-cup'] === 'cup'),
// that third source is redundant here and omitted without changing
// behaviour.
function buildUnitWords() {
  const map = {};
  UNITS.forEach((u) => {
    [u, u + 's'].forEach((w) => {
      map[w] = u;
      map[w.replace(/s$/, '')] = u;
    });
  });
  Object.assign(map, {
    tablespoon: 'tbsp',
    tablespoons: 'tbsp',
    teaspoon: 'tsp',
    teaspoons: 'tsp',
    gram: 'g',
    grams: 'g',
    ounce: 'oz',
    ounces: 'oz',
  });
  return map;
}
const UNIT_WORDS = buildUnitWords();

// Exact port of findKey(): longest exact-label substring match wins;
// falls back to a "loose" match on just the label's first word, but only
// when that first word is at least 4 characters (short heads like "egg"
// are excluded on purpose in the source, presumably to avoid false hits).
function findIngredientKey(text) {
  const low = ' ' + text.toLowerCase() + ' ';
  let hit = null;
  let hitLen = 0;
  let loose = null;
  let looseLen = 0;
  Object.keys(DATA).forEach((k) => {
    const label = (NAMES[k] || k).toLowerCase();
    if (low.indexOf(label) >= 0 && label.length > hitLen) {
      hit = k;
      hitLen = label.length;
    }
    const head = label.split(/[\s,]+/)[0];
    if (head.length >= 4 && low.indexOf(' ' + head) >= 0 && head.length > looseLen) {
      loose = k;
      looseLen = head.length;
    }
  });
  return hit || loose;
}

// Exact port of the per-line body of scale()'s lines.map(...).
function scaleLine(line, ratio, cupMl) {
  const raw = String(line).trim();
  if (!raw) return '';
  const m = raw.match(/^([\d\s\/.,]+)\s*([a-zA-Z]+)?\s+(.*)$/);
  if (!m) return raw;
  const n = parseAmount(m[1]);
  if (!isFinite(n)) return raw;
  const word = (m[2] || '').toLowerCase();
  const u = UNIT_WORDS[word] || UNIT_WORDS[word.replace(/s$/, '')] || '';
  let rest = m[3];
  if (!u) rest = (m[2] ? m[2] + ' ' : '') + rest;
  const scaled = n * ratio;
  const text = (u ? fraction(scaled) + ' ' + u + ' ' : fraction(scaled) + ' ') + rest;
  const key = findIngredientKey(rest);
  if (!key || !u || u === 'g' || u === 'oz') return text;
  const row = DATA[key];
  const dens = density(row, undefined);
  const g = toGrams(row, dens, scaled, u, cupMl);
  return isFinite(g) ? text + '  (' + round(g) + ' g)' : text;
}

function scaleRecipeLines(input) {
  // Source: `Number(fromServ.value) || 1` -- an explicit 0 (or anything
  // that fails to parse) falls back to 1 just like an omitted field does;
  // zod's .default() only covers the "omitted" half of that, so the same
  // falsy-fallback is re-applied by hand here for an explicit 0.
  const fromServings = Number(input.fromServings) || 1;
  const toServings = Number(input.toServings) || 1;
  const ratio = toServings / fromServings;
  const cupMl = input.cupSizeMl == null ? CUSTOMARY_CUP_ML : input.cupSizeMl;
  const lines = (input.lines || []).map((line) => scaleLine(line, ratio, cupMl));
  return { lines };
}

const scaleInputSchema = {
  fromServings: z
    .number()
    .optional()
    .default(1)
    .describe("Servings the recipe as written makes. 0 (or an omitted field) falls back to 1, matching the source tool's own guard."),
  toServings: z
    .number()
    .optional()
    .default(1)
    .describe("Servings wanted. 0 (or an omitted field) falls back to 1, matching the source tool's own guard."),
  lines: z
    .array(z.string().max(MAX_LINE_CHARS))
    .max(MAX_LINES)
    .describe(
      `One ingredient per array entry, as free text (e.g. "2 cups all-purpose flour", "1/2 tsp table salt"), up to ${MAX_LINES} lines of ${MAX_LINE_CHARS} characters each. Lines with no parseable leading amount, or with an amount but no recognisable unit/ingredient after it, are returned unchanged.`
    ),
  cupSizeMl: z
    .number()
    .positive()
    .optional()
    .default(CUSTOMARY_CUP_ML)
    .describe('Cup size in ml used when converting a scaled "cup"/"tbsp"/"tsp" amount to grams. Defaults to the US customary cup (236.588 ml); other common values are 240 or 250.'),
};

function register(server) {
  server.registerTool(
    'recipe_convert_ingredient',
    {
      title: 'Cup-to-grams converter (per-ingredient density)',
      description:
        "Converts an amount of one ingredient between cup, tablespoon, teaspoon, millilitre, gram and ounce using that specific ingredient's own USDA FoodData Central portion weight, not a single water-based figure applied to everything -- a cup of flour (125 g) and a cup of honey (339 g) do not weigh the same. Supports an ingredient's own measurement-style variants where USDA publishes more than one (packed vs loose brown sugar, sifted vs unsifted powdered sugar, whole vs sliced/slivered/ground nuts, etc.), and for baking powder, baking soda and yeast uses USDA's own published teaspoon weight rather than dividing the cup weight by 48, since a spoon measurement of a fine powder is not proportionate to its cup measurement. Also reports, for information, what a generic water-density converter would have said for the same input and by how much that would have been wrong -- omitted when the requested unit is already grams or ounces.",
      inputSchema: ingredientInputSchema,
    },
    async (args) => {
      try {
        const result = computeIngredientConversion(args);
        return toolResult.ok(result);
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );

  server.registerTool(
    'recipe_scale',
    {
      title: 'Recipe servings scaler with gram weights',
      description:
        "Scales a pasted recipe (one ingredient per array entry, e.g. '2 cups all-purpose flour') from one servings count to another, multiplying each line's leading amount by the ratio and reformatting it as a whole number or simple/mixed fraction rather than a decimal. When a line's unit and ingredient can both be recognised against GO AI's density table, appends the scaled amount's weight in grams in parentheses; lines already given in grams or ounces, lines whose ingredient isn't recognised, and lines that don't start with a parseable amount are returned unchanged (the last completely as-is, typos included).",
      inputSchema: scaleInputSchema,
    },
    async (args) => {
      try {
        const result = scaleRecipeLines(args);
        return toolResult.ok(result);
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );
}

module.exports = {
  register,
  toolCount: 2,
  computeIngredientConversion,
  scaleRecipeLines,
  ingredientInputSchema,
  // low-level helpers, exported for direct unit testing against the source's math
  parseAmount,
  round,
  fraction,
  density,
  toGrams,
  variantsOf,
  findIngredientKey,
  MAX_LINES,
  MAX_LINE_CHARS,
};
