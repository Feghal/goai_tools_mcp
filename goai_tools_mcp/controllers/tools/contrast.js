'use strict';
const { z } = require('zod');
const toolResult = require('../../utils/toolResult');

// Ported line-for-line from nginx/sites/goai/tools/contrast.html's inline
// <script> (the client-side WCAG/APCA contrast checker + hue-preserving
// "nearest passing colour" search). Anywhere this file's behaviour differs
// from that source it is called out in a comment at the point of difference.

// See the schema note on `foreground`: badHexError() echoes the value it
// rejected, so the colour fields are bounded. "#rrggbb" is 7 characters; 64
// leaves room for any lenient spelling a caller might try.
const MAX_COLOR_CHARS = 64;

function parseHex(v) {
  v = String(v).trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(v)) v = v[0] + v[0] + v[1] + v[1] + v[2] + v[2];
  if (!/^[0-9a-f]{6}$/i.test(v)) return null;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function toHex(rgb) {
  return '#' + rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');
}

// WCAG 2.x relative luminance: undo the sRGB transfer curve, then weight the
// channels by how much the eye contributes each to brightness.
function luminance(rgb) {
  const c = rgb.map((v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// APCA-W3 0.1.9, exactly as the source implements it (shown for information
// only -- WCAG 2 is what conformance is graded against, never this value).
function apca(txt, bg) {
  let Ytxt = 0.2126729 * Math.pow(txt[0] / 255, 2.4) + 0.7151522 * Math.pow(txt[1] / 255, 2.4) + 0.0721750 * Math.pow(txt[2] / 255, 2.4);
  let Ybg = 0.2126729 * Math.pow(bg[0] / 255, 2.4) + 0.7151522 * Math.pow(bg[1] / 255, 2.4) + 0.0721750 * Math.pow(bg[2] / 255, 2.4);
  const clamp = (Y) => (Y > 0.022 ? Y : Y + Math.pow(0.022 - Y, 1.414));
  Ytxt = clamp(Ytxt);
  Ybg = clamp(Ybg);
  if (Math.abs(Ybg - Ytxt) < 0.0005) return 0;
  let C;
  if (Ybg > Ytxt) C = (Math.pow(Ybg, 0.56) - Math.pow(Ytxt, 0.57)) * 1.14;
  else C = (Math.pow(Ybg, 0.65) - Math.pow(Ytxt, 0.62)) * 1.14;
  if (Math.abs(C) < 0.1) return 0;
  return (C > 0 ? C - 0.027 : C + 0.027) * 100;
}

// --- hue-preserving search: move lightness only, smallest step that clears.
function toHsl(rgb) {
  const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (d) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function toRgb(hsl) {
  const h = hsl[0], s = hsl[1], l = hsl[2];
  if (!s) {
    const v = l * 255;
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}

// Exact port of the source's nearestPassing: walks lightness outward from
// the starting value in 1%-of-range steps (checking the darker step before
// the lighter one at each step), returns the first candidate that clears
// `target`, or null if nothing in [0,1] lightness (same hue/saturation) does.
function nearestPassing(move, fixed, target) {
  const hsl = toHsl(move);
  if (ratio(move, fixed) >= target) return move;
  let best = null, bestDist = Infinity;
  for (let i = 1; i <= 100; i++) {
    [hsl[2] - i / 100, hsl[2] + i / 100].forEach((l) => {
      if (l < 0 || l > 1) return;
      const cand = toRgb([hsl[0], hsl[1], l]);
      if (ratio(cand, fixed) >= target && i < bestDist) {
        best = cand;
        bestDist = i;
      }
    });
    if (best) break; // first hit is the smallest step
  }
  return best;
}

const CASES = [
  { key: 'normal', label: 'Body text', need: '4.5:1', aa: 4.5, aaa: 7 },
  { key: 'large', label: 'Large text', need: '3:1', aa: 3, aaa: 4.5 },
  { key: 'ui', label: 'Icons, borders, focus rings', need: '3:1', aa: 3, aaa: null },
];

function badHexError(field, value) {
  return new Error(`${field}: "${value}" is not a colour this tool can read. Use a hex value like #1a2b3c.`);
}

function checkContrast({ foreground, background }) {
  const fgRgb = parseHex(foreground);
  if (!fgRgb) throw badHexError('foreground', foreground);
  const bgRgb = parseHex(background);
  if (!bgRgb) throw badHexError('background', background);

  const r = ratio(fgRgb, bgRgb);
  // Source truncates (floors) to 2 decimals before display -- it does NOT
  // round -- so a ratio of e.g. 4.499999 displays as "4.49:1", not "4.50:1".
  // Replicated exactly here rather than using the more common round-half-up.
  const ratioTruncated = Math.floor(r * 100) / 100;
  const ratioDisplay = ratioTruncated.toFixed(2) + ':1';

  const rawLc = apca(fgRgb, bgRgb);
  // Source only ever shows Math.round(Math.abs(apca(...))) ("Lc {n}"); we
  // keep that exact integer as lcAbs and additionally expose the signed,
  // 2-decimal value as lc for callers that want more precision than the UI
  // ever renders. polarity is derived from the same sign the algorithm
  // itself branches on (Ybg vs Ytxt), not re-derived independently.
  const lc = Math.round(rawLc * 100) / 100;
  const lcAbs = Math.round(Math.abs(rawLc));
  const polarity = rawLc === 0 ? 'neutral' : rawLc > 0 ? 'normal' : 'reverse';

  let passed = 0, graded = 0;
  const cases = CASES.map((c) => {
    const passAA = r >= c.aa;
    const passAAA = c.aaa === null ? null : r >= c.aaa;
    graded += c.aaa === null ? 1 : 2;
    if (passAA) passed++;
    if (passAAA) passed++;
    return { key: c.key, label: c.label, need: c.need, aaThreshold: c.aa, aaaThreshold: c.aaa, passAA, passAAA };
  });

  return {
    foregroundHex: toHex(fgRgb),
    backgroundHex: toHex(bgRgb),
    ratio: ratioTruncated,
    ratioDisplay,
    apca: { lc, lcAbs, polarity },
    cases,
    summary: { passed, graded, allPass: passed === graded },
  };
}

// The page's two fix buttons ("Nearest passing text colour" / "...
// background") both hard-code target 4.5 (the normal-text AA ratio) when
// calling nearestPassing -- there is no UI control for any other threshold.
// nearestPassing itself takes an arbitrary numeric target, so we generalize
// the tool's `target` parameter to the same named WCAG thresholds the page's
// own table uses (CASES above), defaulting to 'normal-aa' to match the
// buttons' actual behaviour. This is an intentional extension of the
// button-triggered flow, not a change to the underlying algorithm.
const TARGET_PRESETS = {
  'normal-aa': 4.5,
  'normal-aaa': 7,
  'large-aa': 3,
  'large-aaa': 4.5,
  'ui-aa': 3,
};

const NO_SOLUTION_MSG =
  'Nothing in this hue passes against that colour — the pair needs a different hue, not a different lightness.';

function roundRatio(r) {
  return Math.round(r * 100) / 100;
}

function findNearestPassingColor({ foreground, background, adjust, target }) {
  const fgRgb = parseHex(foreground);
  if (!fgRgb) throw badHexError('foreground', foreground);
  const bgRgb = parseHex(background);
  if (!bgRgb) throw badHexError('background', background);

  // The MCP schema applies this same default via zod's .default(), but that
  // only fires when args are parsed through the registered tool -- this
  // function is also called directly (tests, or any other in-process
  // caller), so the default has to live here too.
  if (target === undefined) target = 'normal-aa';
  const targetRatio = Object.prototype.hasOwnProperty.call(TARGET_PRESETS, target) ? TARGET_PRESETS[target] : target;
  if (!(typeof targetRatio === 'number' && targetRatio > 0)) {
    throw new Error(`target: must be a positive ratio or one of ${Object.keys(TARGET_PRESETS).join(', ')} (got ${target}).`);
  }

  const move = adjust === 'foreground' ? fgRgb : bgRgb;
  const fixed = adjust === 'foreground' ? bgRgb : fgRgb;
  const currentRatio = ratio(fgRgb, bgRgb); // ratio(a,b) is order-independent (max/min inside), so this equals ratio(move,fixed)

  const moved = nearestPassing(move, fixed, targetRatio);

  if (!moved) {
    return {
      adjust,
      targetRatio,
      currentRatio: roundRatio(currentRatio),
      alreadyPassing: false,
      found: false,
      movedHex: null,
      newRatio: null,
      lightnessStepPercent: null,
      direction: null,
      message: NO_SOLUTION_MSG,
    };
  }

  // nearestPassing returns the very same array reference it was given (see
  // its own `if (ratio(move, fixed) >= target) return move;` guard) when the
  // pair already passes -- reference equality is a safe, exact way to detect
  // that branch from the caller's side without re-implementing the check.
  const alreadyPassing = moved === move;
  const newRatio = ratio(moved, fixed);

  let lightnessStepPercent = 0, direction = null;
  if (!alreadyPassing) {
    const origHsl = toHsl(move);
    const movedHsl = toHsl(moved);
    const rawStep = (movedHsl[2] - origHsl[2]) * 100;
    lightnessStepPercent = Math.round(Math.abs(rawStep));
    direction = rawStep < 0 ? 'darker' : 'lighter';
  }

  return {
    adjust,
    targetRatio,
    currentRatio: roundRatio(currentRatio),
    alreadyPassing,
    found: true,
    movedHex: toHex(moved),
    newRatio: roundRatio(newRatio),
    lightnessStepPercent,
    direction,
    message: alreadyPassing
      ? `This pair already passes the ${targetRatio}:1 target.`
      : `Moved the ${adjust} colour ${lightnessStepPercent}% of the lightness range (${direction}) to reach ${roundRatio(newRatio)}:1.`,
  };
}

function register(server) {
  server.registerTool(
    'check_contrast',
    {
      title: 'WCAG/APCA contrast checker',
      description:
        "Computes the WCAG 2.x contrast ratio between a foreground (text) and background hex colour, and reports AA/AAA pass or fail for normal text, large text, and UI components (icons/borders/focus rings) separately, since WCAG grades each case on its own threshold. Also reports the newer APCA Lc figure alongside it for information -- APCA is not yet what conformance is measured against, only the WCAG ratio is.",
      inputSchema: {
        // badHexError() echoes the rejected value straight back into its
        // message, so an unbounded colour field is a straight input->output
        // amplifier for anything that fails to parse. A hex colour is 7
        // characters.
        foreground: z.string().min(1).max(MAX_COLOR_CHARS).describe('Foreground/text colour as a hex string, e.g. "#6b7280" or "6b7" (3- or 6-digit, leading # optional).'),
        background: z.string().min(1).max(MAX_COLOR_CHARS).describe('Background colour as a hex string, same format as foreground.'),
      },
    },
    async (args) => {
      try {
        return toolResult.ok(checkContrast(args));
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );

  server.registerTool(
    'find_nearest_passing_color',
    {
      title: 'Nearest WCAG-passing colour (hue-preserving)',
      description:
        "Given a foreground/background hex pair, moves only the lightness of one side (hue and saturation held fixed) in the smallest step that clears a target WCAG contrast ratio, so a failing brand colour can be fixed without draining its hue. Defaults to the 4.5:1 normal-text AA threshold, matching the source page's fix buttons; pass a named threshold ('normal-aa', 'normal-aaa', 'large-aa', 'large-aaa', 'ui-aa') or a custom numeric ratio to target something else. Reports found:false when even pure black or white in that hue cannot reach the target -- that pair needs a different hue, not a different lightness.",
      inputSchema: {
        foreground: z.string().min(1).max(MAX_COLOR_CHARS).describe('Foreground/text colour as a hex string, e.g. "#6b7280" (3- or 6-digit, leading # optional).'),
        background: z.string().min(1).max(MAX_COLOR_CHARS).describe('Background colour as a hex string, same format as foreground.'),
        adjust: z.enum(['foreground', 'background']).describe('Which colour to move toward passing; the other one stays fixed.'),
        target: z
          .union([z.enum(['normal-aa', 'normal-aaa', 'large-aa', 'large-aaa', 'ui-aa']), z.number().positive()])
          .optional()
          .default('normal-aa')
          .describe(
            "WCAG threshold to clear: 'normal-aa' 4.5:1 (default, matches the page's buttons), 'normal-aaa' 7:1, 'large-aa'/'ui-aa' 3:1, 'large-aaa' 4.5:1, or any custom positive ratio."
          ),
      },
    },
    async (args) => {
      try {
        return toolResult.ok(findNearestPassingColor(args));
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );
}

module.exports = {
  register,
  toolCount: 2,
  checkContrast,
  findNearestPassingColor,
  // low-level helpers, exported for direct unit testing against the source's math
  parseHex,
  toHex,
  luminance,
  ratio,
  apca,
  toHsl,
  toRgb,
  nearestPassing,
  MAX_COLOR_CHARS,
};
