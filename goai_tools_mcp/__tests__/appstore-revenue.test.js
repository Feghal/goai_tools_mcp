'use strict';

const { computeAppStoreNetRevenue } = require('../controllers/tools/appstore-revenue');

describe('computeAppStoreNetRevenue', () => {
  test('typical case: £9.99 in the UK at the standard 30% rate (the tool page defaults)', () => {
    // Exact port of the source's render(): base = price / (1 + taxPct/100).
    // price = 9.99, taxPct = 20 (gb's default rate), commission = 30.
    // base  = 9.99 / 1.2               = 8.325000000000001
    // tax   = 9.99 - 8.325000000000001 = 1.6649999999999991
    // cut   = 8.325000000000001 * 0.3  = 2.4975000000000005
    // net   = 8.325000000000001 - cut  = 5.827500000000001
    // All five rounded to the cent, matching the page's own worked example
    // in its prose ("£8.33 ... £2.50 rather than £3.00 ... paid £5.83").
    const result = computeAppStoreNetRevenue({ price: 9.99, countryCode: 'gb' });

    expect(result.input.taxRatePercent).toBe(20);
    expect(result.input.commissionScenario).toBe('standard30');
    expect(result.breakdown).toEqual({
      customerPays: 9.99,
      taxInsidePrice: 1.66,
      commissionBase: 8.33,
      appleCommission: 2.5,
      paidToYou: 5.83,
    });
    // share = Math.round(2.4975000000000005 / 9.99 * 1000) / 10 = 25 (one decimal place)
    expect(result.appleShareOfStickerPercent).toBe(25);
    expect(result.warnings).toEqual([]);

    // naive = 9.99 * (100-30)/100 = 6.993 -> rounds to 6.99, matching the
    // page's own prose ("would promise you £6.99"). The reported difference
    // is computed from the *raw* net/naive (1.1654999999999998 -> 1.17), one
    // cent more than 6.99-5.83=1.16 would suggest -- that mismatch is the
    // source's own rounding order, not a porting bug (see the comment in
    // computeAppStoreNetRevenue).
    expect(result.naiveComparison.naiveNet).toBe(6.99);
    expect(result.naiveComparison.difference).toBe(1.17);
    expect(result.naiveComparison.sameAsActual).toBe(false);

    const standard = result.comparison.find((r) => r.scenario === 'standard30');
    expect(standard.youKeep).toBe(5.83);
    expect(standard.per1000Sales).toBe(5827.5);
    const small = result.comparison.find((r) => r.scenario === 'small15');
    // keep = 8.325000000000001 * 0.85 = 7.076250000000001 -> 7.08
    expect(small.youKeep).toBe(7.08);
    expect(small.per1000Sales).toBe(7076.25);
  });

  test('edge case: US storefront (0% tax baked in) makes the naive and real calculators agree', () => {
    // us.rate = 0, so base === price exactly (price / (1 + 0/100)), the
    // "whyNoTax" branch in the source: nothing comes out at the tax step,
    // and sameAsActual mirrors the page's S.naiveSame branch (`taxPct` falsy).
    const result = computeAppStoreNetRevenue({ price: 9.99, countryCode: 'us' });

    expect(result.input.taxRatePercent).toBe(0);
    expect(result.breakdown.taxInsidePrice).toBe(0);
    expect(result.breakdown.commissionBase).toBe(9.99);
    // cut = 9.99 * 0.3 = 2.997 -> 3.00; net = 9.99 - 2.997 = 6.993 -> 6.99
    expect(result.breakdown.appleCommission).toBe(3);
    expect(result.breakdown.paidToYou).toBe(6.99);
    expect(result.naiveComparison.naiveNet).toBe(6.99);
    expect(result.naiveComparison.difference).toBe(0);
    expect(result.naiveComparison.sameAsActual).toBe(true);
    expect(result.warnings).toEqual([]); // 'us' has no `varies` flag
  });

  test('India (a `varies` storefront) surfaces the warning and honors a caller-supplied taxRatePercent override at the Small Business rate', () => {
    // price = 19.99, taxPct override = 12 (not india's default 18), commission = 15
    // base = 19.99 / 1.12               = 17.8482142857...  -> 17.85
    // tax  = 19.99 - 17.8482142857...   = 2.1417857142...   -> 2.14
    // cut  = 17.8482142857... * 0.15    = 2.6772321428...   -> 2.68
    // share = Math.round(2.6772321428.../19.99 * 1000) / 10 = 13.4
    const result = computeAppStoreNetRevenue({
      price: 19.99,
      countryCode: 'in',
      taxRatePercent: 12,
      commissionScenario: 'small15',
    });

    expect(result.input.taxRatePercent).toBe(12); // override wins over India's default 18
    expect(result.breakdown.commissionBase).toBe(17.85);
    expect(result.breakdown.taxInsidePrice).toBe(2.14);
    expect(result.breakdown.appleCommission).toBe(2.68);
    expect(result.appleShareOfStickerPercent).toBe(13.4);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/varies by province/);
  });
});
