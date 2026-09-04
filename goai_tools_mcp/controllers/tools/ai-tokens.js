'use strict';

const { z } = require('zod');
const toolResult = require('../../utils/toolResult');
const byteLimits = require('../../utils/byteLimits');

// estimateTokens() below runs FOUR global .match() passes over the input.
// Each one allocates an array of one-character strings, so a long non-ASCII
// input costs several times its own size in heap. Measured on this exact
// code: 6,000,000 characters of non-ASCII text = 219 MB of heap inside this
// one function, on a container limited to 400 MB total.
//
// byteLimits.MAX_TEXT_INPUT_CHARS (1,000,000, ~37 MB here) still covers any
// prompt worth sizing -- 1M characters is roughly 250K tokens, more than the
// largest context window in the default list below can hold anyway.
const MAX_TEXT_CHARS = byteLimits.MAX_TEXT_INPUT_CHARS;

// Each custom window becomes one object in the response's contextFit array,
// so the array is an output amplifier as well as an input: "1e9," is five
// bytes in, ~120 bytes of result object out. 64 is far more windows than any
// caller compares against.
const MAX_CONTEXT_WINDOWS = 64;

// Ported from nginx/sites/goai/tools/tokens.html's WINDOWS array. The source
// pulls the display names through an i18n JSON block (translated per
// locale); this server has no locale layer, so the English names ship as-is.
const DEFAULT_CONTEXT_WINDOWS = [
  { name: '8K — older / small models', sizeTokens: 8192 },
  { name: '128K — common current default', sizeTokens: 131072 },
  { name: '200K — large', sizeTokens: 200000 },
  { name: '1M — very large', sizeTokens: 1000000 },
  { name: '2M — largest available', sizeTokens: 2000000 },
];

// Heuristic token estimator, ported line-for-line from the source's
// estimateTokens(): a chars/4 vs words/0.75 baseline, surcharged for
// punctuation, digits and non-Latin characters (all of which tokenize
// denser than plain ASCII prose).
//
// NOTE (verified against source, not the hint): the source's punctuation
// regex `[^\w\s]` runs without the Unicode flag, so in plain ASCII-only
// regex semantics a non-Latin letter (e.g. CJK, Cyrillic, Arabic, Devanagari)
// is neither \w nor \s and therefore also matches as "punctuation". Every
// non-Latin character is effectively surcharged twice: once at +0.85 as
// non-Latin, once more at +0.20 as punctuation. That reads like an
// unintentional bug in the source, but matching the website's numbers
// exactly means reproducing the regex behavior rather than "fixing" it.
function estimateTokens(text) {
  if (!text) return 0;
  const chars = text.length;
  const words = (text.trim().match(/\S+/g) || []).length;
  if (!words) return Math.ceil(chars / 4);
  const nonLatin = (text.match(/[^\x00-\x7F]/g) || []).length;
  const punct = (text.match(/[^\w\s]/g) || []).length;
  const digits = (text.match(/\d/g) || []).length;

  let base = Math.max(chars / 4, words / 0.75);
  base += punct * 0.2; // punctuation often splits off
  base += digits * 0.15; // digits group poorly
  base += nonLatin * 0.85; // non-Latin scripts cost far more per char
  return Math.ceil(base);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// The source's money() renders a display string ("$1.23" / "<$0.01"); this
// is a machine-consumed tool, so cost fields are plain numbers instead.
// Rounding to 8 decimals only erases binary-float noise (e.g. 0.1 + 0.2),
// not precision that matters at any realistic per-token price.
function roundCost(n) {
  return Math.round(n * 1e8) / 1e8;
}

// Source: `words < 200 ? underMinute : minutes.replace(...)`, with the
// per-word rate (220 wpm) only applied once past that 200-word floor.
function computeReadingTime(words) {
  if (!words) return { underOneMinute: false, minutes: null };
  if (words < 200) return { underOneMinute: true, minutes: null };
  return { underOneMinute: false, minutes: Math.round(words / 220) };
}

// Source: fits = tokens <= size; "comfortable" (source's local var `head`)
// = tokens <= size * 0.75; verdict is over / fits (comfortable) / tight
// (fits but not comfortable).
function computeContextFit(tokens, windows) {
  return windows.map((w) => {
    const percentUsed = round2((tokens / w.sizeTokens) * 100);
    const fits = tokens <= w.sizeTokens;
    const comfortable = tokens <= w.sizeTokens * 0.75;
    let verdict = 'fits';
    let overByTokens = null;
    if (!fits) {
      verdict = 'over';
      overByTokens = tokens - w.sizeTokens;
    } else if (!comfortable) {
      verdict = 'tight';
    }
    return { name: w.name, sizeTokens: w.sizeTokens, percentUsed, fits, comfortable, verdict, overByTokens };
  });
}

// Source: ci = (!isNaN(pin) && tokens > 0) ? (tokens/1e6)*pin*calls : null;
// co = !isNaN(pout) ? (outTok/1e6)*pout*calls : null; total = null only
// when both are null. Input cost is deliberately null (not 0) when the
// price is given but the text is empty -- the source shows a "paste
// something to price it" hint for exactly this case.
function computeCost({ tokens, inputPricePerMillionUsd, outputPricePerMillionUsd, expectedOutputTokens, calls }) {
  const callsSafe = Math.max(1, calls || 1);
  const outTok = expectedOutputTokens || 0;
  const inputCost =
    typeof inputPricePerMillionUsd === 'number' && tokens > 0
      ? roundCost((tokens / 1e6) * inputPricePerMillionUsd * callsSafe)
      : null;
  const outputCost =
    typeof outputPricePerMillionUsd === 'number' ? roundCost((outTok / 1e6) * outputPricePerMillionUsd * callsSafe) : null;
  const totalCost = inputCost === null && outputCost === null ? null : roundCost((inputCost || 0) + (outputCost || 0));
  return { inputCost, outputCost, totalCost };
}

// Source: `nonLatin > chars * 0.15 ? nonLatinNote : latinNote`.
function computeAccuracyBand(nonLatin, chars) {
  if (nonLatin > chars * 0.15) {
    return {
      level: 'non_latin_heavy',
      approxRange: '±15-25%',
      note: 'Non-Latin script detected; it tokenizes more densely than this estimate assumes for Latin text.',
    };
  }
  return {
    level: 'typical',
    approxRange: '±10-15%',
    note: 'Ordinary Latin-script prose; the estimate is usually within this range. Code and heavily punctuated text tend to tokenize denser than estimated.',
  };
}

function estimateAiTokens(input) {
  const text = input.text || '';
  const tokens = estimateTokens(text);
  const chars = text.length;
  const words = (text.trim().match(/\S+/g) || []).length;
  const nonLatin = (text.match(/[^\x00-\x7F]/g) || []).length;

  const windows =
    Array.isArray(input.contextWindows) && input.contextWindows.length ? input.contextWindows : DEFAULT_CONTEXT_WINDOWS;

  return {
    tokens,
    characters: chars,
    words,
    charsPerToken: tokens ? round2(chars / tokens) : null,
    readingTime: computeReadingTime(words),
    accuracyBand: computeAccuracyBand(nonLatin, chars),
    contextFit: computeContextFit(tokens, windows),
    cost: computeCost({
      tokens,
      inputPricePerMillionUsd: input.inputPricePerMillionUsd,
      outputPricePerMillionUsd: input.outputPricePerMillionUsd,
      expectedOutputTokens: input.expectedOutputTokens != null ? input.expectedOutputTokens : 500,
      calls: input.calls != null ? input.calls : 1,
    }),
  };
}

function register(server) {
  server.registerTool(
    'estimate_ai_tokens',
    {
      title: 'Estimate AI token count, context fit & cost',
      description:
        "Heuristic estimate (NOT a real per-model BPE tokenizer) of how many tokens a piece of text will become, ported from GO AI's browser-side token counter. Blends a chars/4 and words/0.75 baseline with surcharges for punctuation, digits and non-Latin script; typically within ±10-15% for ordinary English prose and ±15-25% when non-Latin script is detected -- code and heavily punctuated text tend to tokenize denser than this suggests. Also reports whether the text fits a set of context windows (default: 8K/128K/200K/1M/2M tokens, or pass your own) and, if you supply per-million-token prices, an estimated USD cost. Use a provider's own tokenizer for exact billing figures.",
      inputSchema: {
        text: z
          .string()
          .max(MAX_TEXT_CHARS, `text must be ${MAX_TEXT_CHARS} characters or fewer`)
          .describe(`The text to estimate, up to ${MAX_TEXT_CHARS} characters (roughly 250K tokens). An empty string is valid and yields 0 tokens.`),
        inputPricePerMillionUsd: z
          .number()
          .nonnegative()
          .optional()
          .describe(
            'USD price per 1,000,000 input tokens, from the provider\'s current pricing page. Omit to skip input cost -- no default is assumed, since a stale hardcoded price would be worse than none.'
          ),
        outputPricePerMillionUsd: z
          .number()
          .nonnegative()
          .optional()
          .describe('USD price per 1,000,000 output tokens. Omit to skip output cost.'),
        // Both feed O(1) arithmetic, so these ceilings are about keeping the
        // cost figures meaningful rather than about work done.
        expectedOutputTokens: z
          .number()
          .nonnegative()
          .max(10000000)
          .optional()
          .default(500)
          .describe('Assumed reply length in tokens, used only to estimate output cost. Defaults to 500.'),
        calls: z
          .number()
          .positive()
          .max(1000000000)
          .optional()
          .default(1)
          .describe('Number of times this input/output pair will be sent, to scale total cost. Defaults to 1; values below 1 are treated as 1.'),
        contextWindows: z
          .array(
            z.object({
              name: z.string().max(byteLimits.MAX_SHORT_TEXT_CHARS),
              sizeTokens: z.number().positive(),
            })
          )
          .max(MAX_CONTEXT_WINDOWS)
          .optional()
          .describe(
            'Custom context windows to check fit against, e.g. [{"name":"my-model","sizeTokens":32000}]. Omit to use the site default set (8K, 128K, 200K, 1M, 2M).'
          ),
      },
    },
    async (args) => {
      const result = estimateAiTokens(args);
      return toolResult.ok(result);
    }
  );
}

module.exports = {
  register,
  toolCount: 1,
  estimateAiTokens,
  estimateTokens,
  MAX_TEXT_CHARS,
  MAX_CONTEXT_WINDOWS,
};
