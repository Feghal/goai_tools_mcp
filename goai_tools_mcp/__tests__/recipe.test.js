'use strict';

const {
  computeIngredientConversion,
  scaleRecipeLines,
  ingredientInputSchema,
  parseAmount,
  fraction,
} = require('../controllers/tools/recipe');

describe('computeIngredientConversion', () => {
  test('typical case: 1 1/2 cups of all-purpose flour at the default (US customary) cup size', () => {
    // density(flour-ap) = 125 / 236.588 = 0.5283446...
    // grams = n * cupMl * density = 1.5 * 236.588 * (125/236.588) = 1.5 * 125 = 187.5 exactly
    //   (the cupMl and the customary-cup divisor cancel because cupSizeMl defaults to CUSTOMARY_CUP_ML)
    // round(187.5) -> >=100 branch -> Math.round(187.5) = 188
    // ounces = 187.5 / 28.349523125 = 6.613867... -> round to 2dp (< 10) -> 6.61
    // density rounded: 0.5283446 -> round to 2dp -> 0.53
    // water: toGrams('water', ...) = 1.5 * 236.588 * (237/236.588) = 1.5 * 237 = 355.5 exactly
    //   pct = round(|355.5 - 187.5| / 187.5 * 100) = round(168/187.5*100) = round(89.6) = 90 (>= 5, so a message, not "close to water")
    //   round(355.5) -> >=100 branch -> Math.round(355.5) = 356
    const result = computeIngredientConversion({
      ingredient: 'flour-ap',
      amount: '1 1/2',
      unit: 'cup',
      cupSizeMl: 236.588,
    });

    expect(result.grams).toBeCloseTo(187.5, 9);
    expect(result.gramsRounded).toBe(188);
    expect(result.ounces).toBeCloseTo(6.613868, 5);
    expect(result.ouncesRounded).toBe(6.61);
    expect(result.densityGPerMl).toBeCloseTo(0.528345, 5);
    expect(result.densityGPerMlRounded).toBe(0.53);
    expect(result.workSentence).toBe('1 1/2 cup of All-purpose flour = 188 g');
    expect(result.waterComparison).toBe('A water-based converter would say 356 g — off by 90%.');
  });

  test('unit-conversion edge case: baking powder in teaspoons uses its own USDA spoon weight, not cup/48', () => {
    // row.tspExact = 4.6, so toGrams bypasses cupMl/density entirely for the tsp/tbsp branch:
    // grams = n * tspExact = 2 * 4.6 = 9.2 exactly (round(9.2) is already <= 2dp, so unchanged)
    // densityGPerMl is still reported (render() always shows density(key) regardless of the unit
    // used for the grams math): 221/236.588 = 0.934113... -> rounded 0.93
    const result = computeIngredientConversion({
      ingredient: 'bakingpowder',
      amount: '2',
      unit: 'tsp',
      cupSizeMl: 236.588,
    });

    expect(result.grams).toBeCloseTo(9.2, 9);
    expect(result.gramsRounded).toBe(9.2);
    expect(result.densityGPerMl).toBeCloseTo(0.934113, 5);
    expect(result.densityGPerMlRounded).toBe(0.93);
    expect(result.workSentence).toBe('2 tsp of Baking powder = 9.2 g');
    // 2 tsp water ~= 9.875g vs 9.2g -> pct = round(0.675/9.2*100) = round(7.34) = 7
    expect(result.waterComparison).toContain('off by 7%');
  });

  test('variant selection: brown sugar "loose" (145 g/cup) overrides the base 220 g/cup figure', () => {
    // density = 145/236.588; grams = 2 * 236.588 * (145/236.588) = 2*145 = 290 exactly
    const result = computeIngredientConversion({
      ingredient: 'sugar-brown',
      variant: 'loose',
      amount: '2',
      unit: 'cup',
      cupSizeMl: 236.588,
    });

    expect(result.grams).toBeCloseTo(290, 9);
    expect(result.gramsRounded).toBe(290);
    expect(result.workSentence).toBe('2 cup of Brown sugar = 290 g');
  });

  test('recognized bad input: an unparseable amount throws with the source\'s exact "badAmount" message', () => {
    expect(() =>
      computeIngredientConversion({ ingredient: 'flour-ap', amount: 'abc', unit: 'cup', cupSizeMl: 236.588 })
    ).toThrow('Enter an amount, as a decimal or a fraction like 1 1/2.');
  });

  test('cross-field validation: the schema rejects a variant that does not belong to the given ingredient', () => {
    // flour-ap has no selectable variants at all (variants: {"":""}) -> any variant value is invalid.
    const noVariants = ingredientInputSchema.safeParse({
      ingredient: 'flour-ap',
      variant: 'packed',
      amount: '1',
      unit: 'cup',
    });
    expect(noVariants.success).toBe(false);
    expect(noVariants.error.issues[0].path).toEqual(['variant']);

    // sugar-brown does define "packed"/"loose" -> a mismatched value (belongs to a different
    // ingredient's variant set) is still rejected.
    const wrongVariant = ingredientInputSchema.safeParse({
      ingredient: 'sugar-brown',
      variant: 'sliced',
      amount: '1',
      unit: 'cup',
    });
    expect(wrongVariant.success).toBe(false);

    // ... but its own variant is accepted.
    const rightVariant = ingredientInputSchema.safeParse({
      ingredient: 'sugar-brown',
      variant: 'loose',
      amount: '1',
      unit: 'cup',
    });
    expect(rightVariant.success).toBe(true);
  });
});

describe('scaleRecipeLines', () => {
  test('typical case: 4 -> 6 servings (ratio 1.5) reformats amounts as fractions and appends gram weights', () => {
    // "2 cups all-purpose flour": n=2, scaled=2*1.5=3 -> fraction(3)="3" (rest=0 < 0.04 short-circuit)
    //   g = 3 * 236.588 * (125/236.588) = 3*125 = 375 -> round -> 375
    // "200 g butter": already in grams, so no parenthetical is appended even though "butter" is
    //   recognised -- scaled = 200*1.5 = 300 -> fraction(300) = "300"
    // "a pinch of salt": does not start with a parseable amount (leading char is a letter), so the
    //   line's regex never matches and it is returned completely unchanged.
    // "" (blank line): returned as "" without being scaled.
    const result = scaleRecipeLines({
      fromServings: 4,
      toServings: 6,
      lines: ['', '2 cups all-purpose flour', '200 g butter', 'a pinch of salt'],
      cupSizeMl: 236.588,
    });

    expect(result.lines).toEqual(['', '3 cup all-purpose flour  (375 g)', '300 g butter', 'a pinch of salt']);
  });

  test('boundary case: fromServings of 0 falls back to 1, matching the source\'s `Number(...) || 1` guard', () => {
    // fromServings=0 -> Number(0) || 1 -> 1, so ratio = toServings/1 = 2
    // "1 cup granulated sugar": scaled = 1*2 = 2 -> fraction(2) = "2"
    //   g = 2 * 236.588 * (200/236.588) = 2*200 = 400
    const result = scaleRecipeLines({
      fromServings: 0,
      toServings: 2,
      lines: ['1 cup granulated sugar'],
      cupSizeMl: 236.588,
    });

    expect(result.lines).toEqual(['2 cup granulated sugar  (400 g)']);
  });
});

describe('low-level helpers (spot checks against the source\'s exact port)', () => {
  test('parseAmount handles decimal, simple fraction, and mixed-number forms', () => {
    expect(parseAmount('1 1/2')).toBe(1.5);
    expect(parseAmount('3/4')).toBe(0.75);
    expect(parseAmount('.75')).toBe(0.75);
    expect(parseAmount('2')).toBe(2);
    expect(parseAmount('abc')).toBeNaN();
  });

  test('fraction() snaps to the nearest listed eighth/etc within 0.04, else falls back to a rounded decimal', () => {
    expect(fraction(1.5)).toBe('1 1/2');
    expect(fraction(0.5)).toBe('1/2');
    expect(fraction(3)).toBe('3');
    // 0.2 is not within 0.04 of any listed fraction (nearest is 1/4=0.25, d=0.05) -> falls back to round(0.2) = 0.2
    expect(fraction(0.2)).toBe('0.2');
  });
});
