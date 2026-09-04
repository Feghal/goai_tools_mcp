'use strict';

const { z } = require('zod');
const toolResult = require('../../utils/toolResult');

// Ported from website_front/nginx/sites/goai/tools/app-store-revenue.html's
// inline <script> (render() function), using the #revenue-tax and
// #revenue-strings JSON blocks embedded in that page as the ground truth for
// constants and copy. Every rounding rule and the exact order of operations
// below is copied from that file so this tool's numbers match the website's
// for the same input.

// country code -> { standard/default VAT-or-GST rate baked into the sticker
// price, currency symbol, display name, and whether the real-world rate
// varies by province/state/category (India, Canada, Brazil) }. Copied
// verbatim from #revenue-tax and #revenue-strings.
const COUNTRY_TAX = {
  us: { rate: 0, sym: '$', name: 'United States' },
  gb: { rate: 20, sym: '£', name: 'United Kingdom' },
  de: { rate: 19, sym: '€', name: 'Germany' },
  fr: { rate: 20, sym: '€', name: 'France' },
  it: { rate: 22, sym: '€', name: 'Italy' },
  es: { rate: 21, sym: '€', name: 'Spain' },
  nl: { rate: 21, sym: '€', name: 'Netherlands' },
  ie: { rate: 23, sym: '€', name: 'Ireland' },
  at: { rate: 20, sym: '€', name: 'Austria' },
  be: { rate: 21, sym: '€', name: 'Belgium' },
  pt: { rate: 23, sym: '€', name: 'Portugal' },
  gr: { rate: 24, sym: '€', name: 'Greece' },
  fi: { rate: 25.5, sym: '€', name: 'Finland' },
  se: { rate: 25, sym: 'kr', name: 'Sweden' },
  dk: { rate: 25, sym: 'kr', name: 'Denmark' },
  no: { rate: 25, sym: 'kr', name: 'Norway' },
  pl: { rate: 23, sym: 'zł', name: 'Poland' },
  ch: { rate: 8.1, sym: 'CHF', name: 'Switzerland' },
  tr: { rate: 20, sym: '₺', name: 'Turkey' },
  jp: { rate: 10, sym: '¥', name: 'Japan' },
  kr: { rate: 10, sym: '₩', name: 'South Korea' },
  au: { rate: 10, sym: '$', name: 'Australia' },
  nz: { rate: 15, sym: '$', name: 'New Zealand' },
  sg: { rate: 9, sym: '$', name: 'Singapore' },
  id: { rate: 12, sym: 'Rp', name: 'Indonesia' },
  cn: { rate: 6, sym: '¥', name: 'China' },
  in: { rate: 18, sym: '₹', varies: true, name: 'India' },
  ca: { rate: 5, sym: '$', varies: true, name: 'Canada' },
  br: { rate: 17, sym: 'R$', varies: true, name: 'Brazil' },
  mx: { rate: 16, sym: '$', name: 'Mexico' },
  ae: { rate: 5, sym: 'AED', name: 'United Arab Emirates' },
  sa: { rate: 15, sym: 'SAR', name: 'Saudi Arabia' },
  za: { rate: 15, sym: 'R', name: 'South Africa' },
};

// The source's RATES array is [['rateStandard', 30], ['rateSmall', 15],
// ['rateYearTwo', 15]], selected by <select id="rate">'s numeric index. Given
// snake_case scenario keys here instead of that index, with labels copied
// verbatim from #revenue-strings.
const SCENARIOS = {
  standard30: { percent: 30, label: 'Standard, 30%' },
  small15: { percent: 15, label: 'Small Business Program, 15%' },
  yearTwo15: { percent: 15, label: 'Subscription after one year, 15%' },
};
const SCENARIO_KEYS = Object.keys(SCENARIOS);
const COUNTRY_CODES = Object.keys(COUNTRY_TAX);

const VARIES_WARNING =
  "This storefront's rate varies by province, state or category; the figure used is a common one -- pass your own taxRatePercent if you know it.";

// Matches the source's money() formatting precision (toLocaleString with
// minimumFractionDigits/maximumFractionDigits: 2) closely enough that every
// value checked against the page's own worked examples agrees to the cent,
// including cases where the raw float sits just under a .xx5 boundary (e.g.
// 9.99 at 20% VAT yields tax = 1.6649999999999991, which both this and
// toLocaleString round down to 1.66, not up to 1.67).
function round2(n) {
  return Math.round(n * 100) / 100;
}

function computeAppStoreNetRevenue(input) {
  const countryCode = input.countryCode || 'gb'; // source's own <select> default
  const country = COUNTRY_TAX[countryCode];

  const price = input.price;
  // Source: `if (!isFinite(taxPct) || taxPct < 0) taxPct = 0;`, but the field
  // starts pre-filled with the storefront's own rate on country selection --
  // schema validation (min 0) already rules out the negative/non-finite
  // cases, so the only behavior left to port is "falls back to the
  // storefront's rate when not given".
  const taxRatePercent = input.taxRatePercent === undefined ? country.rate : input.taxRatePercent;

  const scenarioKey = input.commissionScenario || 'standard30';
  const commissionPercent = SCENARIOS[scenarioKey].percent;

  // Exact port of render()'s math: the sticker already contains the tax, so
  // the commission base is price / (1 + rate/100), not the price itself.
  const base = price / (1 + taxRatePercent / 100);
  const taxInsidePrice = price - base;
  const appleCommission = (base * commissionPercent) / 100;
  const paidToYou = base - appleCommission;

  // Source: `Math.round(cut / price * 1000) / 10` -- one decimal place, not two.
  const appleShareOfStickerPercent = Math.round((appleCommission / price) * 1000) / 10;

  // The compare table on the page always shows all three scenarios side by
  // side, computed from the same commission base regardless of which one is
  // selected in the <select> -- reproduced the same way here.
  const comparison = SCENARIO_KEYS.map((key) => {
    const percent = SCENARIOS[key].percent;
    const keep = (base * (100 - percent)) / 100;
    return {
      scenario: key,
      label: SCENARIOS[key].label,
      commissionPercent: percent,
      youKeep: round2(keep),
      per1000Sales: round2(keep * 1000),
    };
  });

  // Exact port of the page's naive-calculator status line: what a calculator
  // that just takes the commission off the sticker (ignoring the tax already
  // inside it) would promise, versus what actually lands. The source computes
  // `diff` from the raw (pre-rounding) net and naive figures and only rounds
  // the difference itself for display, so it can land a cent away from what
  // subtracting the two *rounded* headline numbers would give -- e.g. the
  // £9.99/20%/30% example below rounds to a £1.17 gap even though 6.99 - 5.83
  // = 1.16; that is the source's own behavior, not a porting bug.
  const naiveNet = (price * (100 - commissionPercent)) / 100;
  const naiveComparison = {
    commissionPercent,
    naiveNet: round2(naiveNet),
    actualNet: round2(paidToYou),
    difference: round2(Math.abs(paidToYou - naiveNet)),
    sameAsActual: taxRatePercent === 0,
  };

  const warnings = [];
  if (country.varies) warnings.push(VARIES_WARNING);

  return {
    input: {
      price: round2(price),
      countryCode,
      countryName: country.name,
      currencySymbol: country.sym,
      taxRatePercent,
      commissionScenario: scenarioKey,
    },
    breakdown: {
      customerPays: round2(price),
      taxInsidePrice: round2(taxInsidePrice),
      commissionBase: round2(base),
      appleCommission: round2(appleCommission),
      paidToYou: round2(paidToYou),
    },
    appleShareOfStickerPercent,
    comparison,
    naiveComparison,
    warnings,
  };
}

const inputSchema = {
  price: z
    .number()
    .positive()
    // O(1) arithmetic, so an absurd price is no DoS -- bounded only so the
    // per-1000-sales figures stay meaningful numbers. The most expensive app
    // Apple has ever listed is four figures.
    .max(1000000)
    .describe('The customer-facing sticker price for this storefront (already tax-inclusive everywhere except the US).'),
  countryCode: z
    .enum(COUNTRY_CODES)
    .default('gb')
    .describe(
      'Two-letter App Store storefront code (e.g. us, gb, de, jp, in). Selects the default tax rate and currency symbol. Defaults to gb, matching the tool page.'
    ),
  taxRatePercent: z
    .number()
    .min(0)
    // The page's own <input min="0" max="99"> -- the calc itself never
    // enforces this upper bound, it is just the site's own sane-input hint,
    // kept here too (see tdee.js's `age` field for the same pattern).
    .max(99)
    .optional()
    .describe(
      "Override the storefront's default tax rate baked into the price, as a percent (e.g. 20 for 20% VAT). Defaults to the selected countryCode's standard rate (0 for the US). Some storefronts' real rates vary by province, state or category -- see the warnings array."
    ),
  commissionScenario: z
    .enum(SCENARIO_KEYS)
    .default('standard30')
    .describe(
      "Which Apple commission rate applies to the tax-exclusive remainder: 'standard30' (30%, the default for most apps), 'small15' (15%, Apple's Small Business Program for developers under the program's proceeds threshold), or 'yearTwo15' (15%, the reduced rate a subscription bills at after a subscriber has accumulated one year of paid, unlapsed service). All three are always returned side by side in the comparison array regardless of which is selected here."
    ),
};

function register(server) {
  server.registerTool(
    'calculate_app_store_net_revenue',
    {
      title: 'App Store net revenue calculator',
      description:
        "Computes what a developer actually receives from an App Store sale: first removes the storefront's VAT/GST already baked into the customer-facing sticker price, then applies Apple's commission (standard 30%, Small Business Program 15%, or the post-year-one subscription 15%) to that tax-exclusive remainder -- NOT to the sticker price itself, which is the mistake most naive calculators make. Returns a full price breakdown, the effective share of the sticker Apple actually keeps, a side-by-side comparison across all three commission rates (including per-1,000-sales figures), a naive-calculator sanity check showing how far off a 'just take the commission off the top' estimate would be, and warnings when the selected storefront's real tax rate varies by province, state or category (India, Canada, Brazil) rather than being a single fixed number.",
      inputSchema,
    },
    async (args) => {
      try {
        const result = computeAppStoreNetRevenue(args);
        return toolResult.ok(result);
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );
}

module.exports = {
  register,
  toolCount: 1,
  computeAppStoreNetRevenue,
  COUNTRY_TAX,
  SCENARIOS,
  inputSchema,
};
