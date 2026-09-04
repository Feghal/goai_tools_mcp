'use strict';

const { estimateAiTokens, estimateTokens } = require('../controllers/tools/ai-tokens');

const DEFAULT_WINDOW_NAMES = [
  '8K — older / small models',
  '128K — common current default',
  '200K — large',
  '1M — very large',
  '2M — largest available',
];

describe('estimateTokens (pure heuristic, ported from tokens.html)', () => {
  test('hand-computed count for mixed punctuation/digit text', () => {
    const text = 'Hello, world! 123';
    // chars = 17 ("Hello, world! 123".length)
    // words = 3 ("Hello,", "world!", "123")
    // punct = 2 ("," and "!")            digits = 3 ("1","2","3")      nonLatin = 0
    // base  = max(17/4, 3/0.75) = max(4.25, 4) = 4.25
    // base += 2*0.20 = 0.40  -> 4.65
    // base += 3*0.15 = 0.45  -> 5.10
    // base += 0*0.85 = 0     -> 5.10
    // tokens = ceil(5.10) = 6
    expect(estimateTokens(text)).toBe(6);
  });

  test('empty string short-circuits to 0 tokens', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('estimateAiTokens', () => {
  test('typical text: full shape, default context windows, priced cost', () => {
    const result = estimateAiTokens({
      text: 'Hello, world! 123',
      inputPricePerMillionUsd: 2,
      outputPricePerMillionUsd: 10,
      expectedOutputTokens: 100,
      calls: 2,
    });

    expect(result.tokens).toBe(6);
    expect(result.characters).toBe(17);
    expect(result.words).toBe(3);
    // charsPerToken = 17 / 6 = 2.8333... -> 2.83
    expect(result.charsPerToken).toBeCloseTo(2.83, 2);
    expect(result.readingTime).toEqual({ underOneMinute: true, minutes: null });
    expect(result.accuracyBand.level).toBe('typical');

    expect(result.contextFit).toHaveLength(5);
    expect(result.contextFit.map((w) => w.name)).toEqual(DEFAULT_WINDOW_NAMES);
    // 6 tokens fits every default window comfortably (<=75% of even the 8K one).
    result.contextFit.forEach((w) => {
      expect(w.fits).toBe(true);
      expect(w.comfortable).toBe(true);
      expect(w.verdict).toBe('fits');
      expect(w.overByTokens).toBeNull();
    });
    // 6 / 8192 * 100 = 0.0732421875% -> rounds to 0.07
    expect(result.contextFit[0].percentUsed).toBeCloseTo(0.07, 2);

    // inputCost  = (6/1e6)   * 2  * 2 = 0.000024
    // outputCost = (100/1e6) * 10 * 2 = 0.002
    // totalCost  = 0.002024
    expect(result.cost.inputCost).toBeCloseTo(0.000024, 8);
    expect(result.cost.outputCost).toBeCloseTo(0.002, 8);
    expect(result.cost.totalCost).toBeCloseTo(0.002024, 8);
  });

  test('edge case: empty text keeps input cost null even when a price is given (source shows a "paste text to price it" hint for exactly this)', () => {
    const result = estimateAiTokens({
      text: '',
      inputPricePerMillionUsd: 5,
      // outputPricePerMillionUsd omitted; expectedOutputTokens/calls default to 500/1
    });

    expect(result.tokens).toBe(0);
    expect(result.charsPerToken).toBeNull();
    expect(result.readingTime).toEqual({ underOneMinute: false, minutes: null });
    // 0 tokens trivially "fits" every window.
    expect(result.contextFit.every((w) => w.fits && w.verdict === 'fits')).toBe(true);

    expect(result.cost.inputCost).toBeNull();
    expect(result.cost.outputCost).toBeNull();
    expect(result.cost.totalCost).toBeNull();
  });

  test('non-Latin script is double-surcharged by the source regex, and a custom undersized context window reports "over"', () => {
    const result = estimateAiTokens({
      text: '你好', // "你好" -- 2 CJK chars, 1 whitespace-delimited word
      contextWindows: [{ name: 'tiny', sizeTokens: 3 }],
    });

    // chars=2, words=1, nonLatin=2, punct=2 (each CJK char is neither \w nor \s
    // under the source's non-Unicode regex, so it's counted as punct too), digits=0
    // base = max(2/4, 1/0.75) = max(0.5, 1.3333) = 1.3333
    // base += 2*0.20 = 0.40 -> 1.7333
    // base += 2*0.85 = 1.70 -> 3.4333
    // tokens = ceil(3.4333) = 4
    expect(result.tokens).toBe(4);
    expect(result.accuracyBand.level).toBe('non_latin_heavy');

    expect(result.contextFit).toHaveLength(1);
    const [fit] = result.contextFit;
    expect(fit.name).toBe('tiny');
    expect(fit.fits).toBe(false);
    expect(fit.comfortable).toBe(false);
    expect(fit.verdict).toBe('over');
    expect(fit.overByTokens).toBe(1); // 4 tokens - 3 token window
  });
});
