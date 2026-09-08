'use strict';
const { z } = require('zod');
const toolResult = require('../../utils/toolResult');
const toolAnnotations = require('../../utils/toolAnnotations');

/* ---------------------------------------------------------------------------
 * OKLab / OKLCH math and the CSS Color 4 gamut-mapping algorithm, ported
 * verbatim from website_front/nginx/sites/goai/assets/oklch.js (Björn
 * Ottosson's matrices; gamut mapping per CSS Color 4 §13 — reduce chroma at
 * constant lightness and hue rather than clipping channels). Kept in this
 * exact numeric form so the tool's numbers match the live page's numbers for
 * the same input.
 * ------------------------------------------------------------------------- */
const JND = 0.02;
const EPSILON = 0.0001;

function toLinear(c) {
  const a = Math.abs(c);
  return a <= 0.04045 ? c / 12.92 : Math.sign(c) * Math.pow((a + 0.055) / 1.055, 2.4);
}
function toGamma(c) {
  const a = Math.abs(c);
  return a <= 0.0031308 ? c * 12.92 : Math.sign(c) * (1.055 * Math.pow(a, 1 / 2.4) - 0.055);
}
function linearToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  };
}
function oklabToLinear(L, A, B) {
  let l = L + 0.3963377774 * A + 0.2158037573 * B;
  let m = L - 0.1055613458 * A - 0.0638541728 * B;
  let s = L - 0.0894841775 * A - 1.2914855480 * B;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  };
}
function rgbToOklch(rgb) {
  const lab = linearToOklab(toLinear(rgb.r / 255), toLinear(rgb.g / 255), toLinear(rgb.b / 255));
  const c = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  const h = c < 1e-7 ? 0 : (Math.atan2(lab.b, lab.a) * 180 / Math.PI + 360) % 360;
  return { l: lab.L, c, h };
}
function oklchToLab(col) {
  const rad = (col.h * Math.PI) / 180;
  return { L: col.l, a: col.c * Math.cos(rad), b: col.c * Math.sin(rad) };
}
// Unclamped on purpose: the caller (gamutMap) needs to see a channel leave
// the cube before deciding what to do about it.
function oklchToRgb(col) {
  const lab = oklchToLab(col);
  const lin = oklabToLinear(lab.L, lab.a, lab.b);
  return { r: toGamma(lin.r) * 255, g: toGamma(lin.g) * 255, b: toGamma(lin.b) * 255 };
}
function inGamut(col) {
  const rgb = oklchToRgb(col);
  const t = -0.000075 * 255;
  return rgb.r >= t && rgb.g >= t && rgb.b >= t && rgb.r <= 255 - t && rgb.g <= 255 - t && rgb.b <= 255 - t;
}
function clip(col) {
  const rgb = oklchToRgb(col);
  return {
    r: Math.min(255, Math.max(0, rgb.r)),
    g: Math.min(255, Math.max(0, rgb.g)),
    b: Math.min(255, Math.max(0, rgb.b)),
  };
}
function deltaEOK(a, b) {
  const x = oklchToLab(a), y = oklchToLab(b);
  const dl = x.L - y.L, da = x.a - y.a, db = x.b - y.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}
// CSS Color 4 §13.2: bisect on chroma, and where the clipped colour already
// sits within a just-noticeable difference of the reduced one, keep the
// extra chroma instead of giving it up.
function gamutMap(col) {
  if (col.l >= 1) return { rgb: { r: 255, g: 255, b: 255 }, oklch: { l: 1, c: 0, h: col.h }, mapped: true };
  if (col.l <= 0) return { rgb: { r: 0, g: 0, b: 0 }, oklch: { l: 0, c: 0, h: col.h }, mapped: true };
  if (inGamut(col)) return { rgb: clip(col), oklch: col, mapped: false };

  let lo = 0, hi = col.c;
  let clipped = clip(col);
  while (hi - lo > EPSILON) {
    const chroma = (lo + hi) / 2;
    const current = { l: col.l, c: chroma, h: col.h };
    if (inGamut(current)) { lo = chroma; continue; }
    clipped = clip(current);
    const e = deltaEOK(rgbToOklch(clipped), current);
    if (e < JND) {
      if (JND - e < EPSILON) break;
      lo = chroma;
    } else {
      hi = chroma;
    }
  }
  return { rgb: clipped, oklch: rgbToOklch(clipped), mapped: true };
}
function rgbToHsl(rgb) {
  const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}
function hslToRgb(hsl) {
  const h = (((hsl.h % 360) + 360) % 360) / 360, s = hsl.s / 100, l = hsl.l / 100;
  if (!s) { const v = l * 255; return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  function channel(t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }
  return { r: channel(h + 1 / 3) * 255, g: channel(h) * 255, b: channel(h - 1 / 3) * 255 };
}
function hexOf(rgb) {
  return '#' + [rgb.r, rgb.g, rgb.b]
    .map((v) => ('0' + Math.round(Math.min(255, Math.max(0, v))).toString(16)).slice(-2))
    .join('');
}
// Parses hex / rgb() / rgba() / hsl() / hsla() / oklch() text into an OKLCH
// object, or returns null. Faithful to the source's leniency: rgb()/hsl()
// percentage signs on individual channels are NOT scaled (matches source),
// and oklch() values are returned unclamped/unvalidated.
function parseColor(text) {
  const s = String(text).trim().toLowerCase();
  let m;
  if ((m = s.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/))) {
    let v = m[1];
    if (v.length === 3) v = v[0] + v[0] + v[1] + v[1] + v[2] + v[2];
    return rgbToOklch({ r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) });
  }
  if ((m = s.match(/^rgba?\(([^)]+)\)$/))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return rgbToOklch({ r: p[0], g: p[1], b: p[2] });
  }
  if ((m = s.match(/^hsla?\(([^)]+)\)$/))) {
    const q = m[1].split(/[\s,/%]+/).filter(Boolean).map(parseFloat);
    return rgbToOklch(hslToRgb({ h: q[0], s: q[1], l: q[2] }));
  }
  if ((m = s.match(/^oklch\(([^)]+)\)$/))) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    let l = parseFloat(parts[0]);
    if (parts[0].indexOf('%') >= 0) l /= 100;
    return { l, c: parseFloat(parts[1]) || 0, h: parseFloat(parts[2]) || 0 };
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * Display formatting, ported from the inline <script> on tools/oklch.html.
 * ------------------------------------------------------------------------- */
function roundN(v, places) {
  return Math.round(v * Math.pow(10, places)) / Math.pow(10, places);
}
function oklchText(col) {
  return 'oklch(' + roundN(col.l * 100, 2) + '% ' + roundN(col.c, 4) + ' ' + roundN(col.h, 2) + ')';
}

const MAPPED_TAG = 'mapped'; // oklch-strings JSON: S.mappedTag
const BAD_COLOR_MESSAGE = 'Not a colour this understands.'; // oklch-strings JSON: S.bad
const CROSS_FIELD_MESSAGE = "Provide either 'color', or all three of l, c and h.";

/* ---------------------------------------------------------------------------
 * Shared input shape + resolution.
 * ------------------------------------------------------------------------- */
// A CSS colour literal. Bounded because parseColor() runs four anchored
// regexes over it and the longest legitimate form ("oklch(100% 0.4 360)") is
// under 30 characters.
const MAX_COLOR_CHARS = 128;

// The ramp stem is sanitized then interpolated into up to 24 CSS custom
// property lines, so its length is multiplied by 24 in the response.
const MAX_NAME_CHARS = 64;

const baseColorShape = {
  color: z.string().max(MAX_COLOR_CHARS).optional()
    .describe("CSS color to convert from — hex ('#5b8cff' or '#58f'), rgb()/rgba(), hsl()/hsla(), or oklch(). Takes precedence over l/c/h when both are supplied."),
  l: z.number().optional()
    .describe('OKLCH lightness, 0 (black) to 1 (white). Used (with c and h) only when color is omitted.'),
  c: z.number().optional()
    .describe("OKLCH chroma. sRGB's most saturated colour reaches about 0.31; the source page's own slider goes to 0.4 so out-of-gamut requests are possible on purpose. Used (with l and h) only when color is omitted."),
  h: z.number().optional()
    .describe('OKLCH hue in degrees, 0-360. Used (with l and c) only when color is omitted.'),
};
function hasColorOrLch(v) {
  return v.color !== undefined || (v.l !== undefined && v.c !== undefined && v.h !== undefined);
}

const convertInputSchema = z.object(baseColorShape).refine(hasColorOrLch, {
  message: CROSS_FIELD_MESSAGE,
  path: ['color'],
});

const rampInputSchema = z.object({
  ...baseColorShape,
  mode: z.enum(['hue', 'light', 'chroma']).default('hue')
    .describe("Which channel the ramp sweeps while holding the other two fixed: 'hue' rotates hue around the wheel, 'light' sweeps lightness from a near-black floor to a near-white ceiling, 'chroma' sweeps chroma from 0 up to the base colour's own chroma."),
  steps: z.number().int().min(3).max(24).default(9)
    .describe('Number of swatches in the ramp, 3-24.'),
  name: z.string().max(MAX_NAME_CHARS).default('brand')
    .describe("Stem for the generated CSS custom properties (e.g. 'brand' produces --brand-1, --brand-2, ...); sanitized to [a-z0-9-] the same way the source page does."),
}).refine(hasColorOrLch, {
  message: CROSS_FIELD_MESSAGE,
  path: ['color'],
});

// Returns the base OKLCH colour for either input mode. Throws for
// unparseable `color` text — an expected bad-input condition the schema
// itself cannot express, caught and turned into toolResult.fail by register().
function resolveBase({ color, l, c, h }) {
  if (color !== undefined) {
    const parsed = parseColor(color);
    if (!parsed) throw new Error(BAD_COLOR_MESSAGE);
    return parsed;
  }
  return { l, c, h };
}

/* ---------------------------------------------------------------------------
 * Pure tool logic.
 * ------------------------------------------------------------------------- */
function convertColor(args) {
  const requested = resolveBase(args);
  const mapped = gamutMap(requested);
  const rgb = mapped.rgb; // gamut-clamped, NOT yet rounded — matches the page, which
                           // derives HSL from these unrounded values and only rounds
                           // the RGB channels for display.
  const hexStr = hexOf(rgb);
  const hsl = rgbToHsl(rgb);
  const r = Math.round(rgb.r), g = Math.round(rgb.g), b = Math.round(rgb.b);

  const out = {
    requested: { l: requested.l, c: requested.c, h: requested.h },
    oklchText: oklchText(requested),
    inGamut: !mapped.mapped,
    mapped: mapped.mapped,
    hex: hexStr,
    rgb: { r, g, b },
    rgbText: `rgb(${r} ${g} ${b})`,
    hsl: { h: roundN(hsl.h, 1), s: roundN(hsl.s, 1), l: roundN(hsl.l, 1) },
    hslText: `hsl(${roundN(hsl.h, 1)} ${roundN(hsl.s, 1)}% ${roundN(hsl.l, 1)}%)`,
  };
  if (mapped.mapped) out.mappedChroma = roundN(mapped.oklch.c, 4);
  return out;
}

function buildRamp(args) {
  const base = resolveBase(args);
  // Anything other than 'hue'/'light' falls through to the chroma formula —
  // that's the source's own ternary chain, not an oversight here.
  const mode = args.mode || 'hue';
  // Source: Math.max(3, Math.min(24, +$('steps').value || 9)) — note 0/NaN
  // fall back to 9 rather than clamping up to 3; preserved for parity.
  const rawSteps = Number(args.steps);
  const steps = Math.max(3, Math.min(24, rawSteps || 9));
  const name = (args.name || 'colour').trim().replace(/[^a-z0-9-]+/gi, '-');

  const stepsOut = [];
  const cssLines = [];
  for (let i = 0; i < steps; i++) {
    const f = steps === 1 ? 0 : i / (steps - 1);
    let col;
    if (mode === 'hue') {
      col = { l: base.l, c: base.c, h: (base.h + (360 * i) / steps) % 360 };
    } else if (mode === 'light') {
      // Ends stop short of pure black/white on purpose (source comment): a
      // token set wants a near-black and a near-white, not a hueless pair.
      col = { l: 0.15 + f * 0.8, c: base.c, h: base.h };
    } else {
      col = { l: base.l, c: f * base.c, h: base.h };
    }
    const m = gamutMap(col);
    const hexStr = hexOf(m.rgb);
    const text = oklchText(col);
    stepsOut.push({
      index: i + 1,
      oklch: { l: col.l, c: col.c, h: col.h },
      oklchText: text,
      hex: hexStr,
      mapped: m.mapped,
    });
    // The requested colour is written to CSS, not the mapped one — a wider
    // gamut screen runs the same mapping itself and can show the extra
    // chroma; the hex comment is the sRGB fallback/preview.
    cssLines.push(`  --${name}-${i + 1}: ${text};  /* ${hexStr}${m.mapped ? ' ' + MAPPED_TAG : ''} */`);
  }

  return {
    base: { l: base.l, c: base.c, h: base.h },
    mode,
    steps: stepsOut,
    css: ':root {\n' + cssLines.join('\n') + '\n}',
  };
}

/* ---------------------------------------------------------------------------
 * Registration.
 * ------------------------------------------------------------------------- */
// The shape of the JSON in structuredContent. Declared so an agent can
// read the result without parsing prose -- and, because the SDK validates
// every success against it, so a handler that quietly stops returning a
// field fails here instead of downstream. Nullable fields below are the
// ones the computation genuinely leaves empty, not defensive padding.
const oklchConvertOutputSchema = {
  requested: z
    .object({
      l: z.number().describe('Requested lightness, 0-1.'),
      c: z.number().describe('Requested chroma.'),
      h: z.number().describe('Requested hue angle in degrees.'),
    })
    .describe('The OKLCH coordinates that were asked for, before any gamut mapping -- keep these to see how far the sRGB answer had to move.'),
  oklchText: z.string().describe('The colour as a CSS oklch() declaration.'),
  inGamut: z.boolean().describe('Whether the requested colour exists in sRGB.'),
  mapped: z.boolean().describe('True when the colour was gamut-mapped to fit sRGB, meaning hex below is a near miss rather than the exact request.'),
  hex: z.string().describe('The sRGB result as a hex string.'),
  rgb: z
    .object({
      r: z.number().int().describe('Red channel, 0-255.'),
      g: z.number().int().describe('Green channel, 0-255.'),
      b: z.number().int().describe('Blue channel, 0-255.'),
    })
    .describe('The same colour as 8-bit sRGB channels.'),
  rgbText: z.string().describe('The colour as a CSS rgb() declaration.'),
  hsl: z
    .object({
      h: z.number().describe('Hue in degrees.'),
      s: z.number().describe('Saturation as a percentage.'),
      l: z.number().describe('Lightness as a percentage. Note this is HSL lightness, which is not OKLCH lightness.'),
    })
    .describe('The same colour in HSL, for code that still expects it.'),
  hslText: z.string().describe('The colour as a CSS hsl() declaration.'),
};

// The shape of the JSON in structuredContent. Declared so an agent can
// read the result without parsing prose -- and, because the SDK validates
// every success against it, so a handler that quietly stops returning a
// field fails here instead of downstream. Nullable fields below are the
// ones the computation genuinely leaves empty, not defensive padding.
const oklchRampOutputSchema = {
  base: z
    .object({
      l: z.number().describe('Base lightness, 0-1.'),
      c: z.number().describe('Base chroma.'),
      h: z.number().describe('Base hue angle in degrees.'),
    })
    .describe('The OKLCH coordinates the ramp was generated from.'),
  mode: z.enum(['hue', 'light', 'chroma']).describe('Which coordinate was varied across the steps, echoed from the input.'),
  steps: z
    .array(
      z.object({
        index: z.number().int().describe('0-based position in the ramp.'),
        oklch: z
          .object({
            l: z.number().describe('Lightness at this step.'),
            c: z.number().describe('Chroma at this step.'),
            h: z.number().describe('Hue at this step.'),
          })
          .describe('This step\'s OKLCH coordinates.'),
        oklchText: z.string().describe('This step as a CSS oklch() declaration.'),
        hex: z.string().describe('This step as an sRGB hex string.'),
        mapped: z.boolean().describe('True when this particular step fell outside sRGB and was gamut-mapped.'),
      })
    )
    .describe('The ramp in order. Because each step is mapped independently, some can be mapped and others not.'),
  css: z.string().describe('The whole ramp as CSS custom properties, ready to paste into a stylesheet.'),
};

function register(server) {
  server.registerTool(
    'oklch_convert',
    {
      title: 'Convert an OKLCH / hex / RGB / HSL color',
      description:
        "Converts a color to and from OKLCH. Accepts either a CSS color string via `color` (hex, rgb()/rgba(), hsl()/hsla(), or oklch()) or explicit OKLCH lightness/chroma/hue via l, c and h — supply one or the other. Returns the canonical oklch() text for the color exactly as requested, plus its sRGB-gamut-mapped hex/rgb()/hsl() equivalents. Gamut mapping follows the CSS Color 4 algorithm (bisecting on chroma at constant lightness and hue, not channel-clipping) and only targets sRGB — there is no P3 or Rec2020 support.",
      annotations: toolAnnotations.PURE,
      outputSchema: oklchConvertOutputSchema,
      inputSchema: convertInputSchema,
    },
    async (args) => {
      try {
        return toolResult.ok(convertColor(args));
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );

  server.registerTool(
    'oklch_ramp',
    {
      title: 'Build an OKLCH swatch ramp / CSS custom-property block',
      description:
        "Builds a perceptually even OKLCH swatch ramp from a base color (same `color` or l/c/h input as oklch_convert) by sweeping one channel — hue, lightness, or chroma — while holding the other two fixed, so every swatch keeps the same visual weight (this is the reason to build a ramp in OKLCH rather than HSL). Each step is gamut-mapped to sRGB with the CSS Color 4 chroma-reduction algorithm and returned with its hex preview, plus a ready-to-paste `:root { --name-1: oklch(...); ... }` CSS block.",
      annotations: toolAnnotations.PURE,
      outputSchema: oklchRampOutputSchema,
      inputSchema: rampInputSchema,
    },
    async (args) => {
      try {
        return toolResult.ok(buildRamp(args));
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );
}

module.exports = {
  register,
  toolCount: 2,
  convertColor,
  buildRamp,
  convertInputSchema,
  rampInputSchema,
  parseColor,
  MAX_COLOR_CHARS,
  MAX_NAME_CHARS,
};
