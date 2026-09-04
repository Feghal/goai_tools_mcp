'use strict';
const { z } = require('zod');
const toolResult = require('../../utils/toolResult');

// English UI strings mirrored verbatim from the source's
// <script type="application/json" id="clamp-strings"> block (nginx/sites/goai/tools/clamp.html).
// Kept as constants here since this module has no DOM/JSON script tag to read from.
const STRINGS = {
  sameVw: 'The two viewports must differ.',
  inverted: 'Max is smaller than min, so the size shrinks as the screen grows.',
  flat: 'Both sizes are equal, so this is a constant — clamp() is not needed.',
};

// See the schema note on previewViewportsPx.
const MAX_PREVIEW_VIEWPORTS = 64;

// Matches the source's `trim()`: round to 4 decimal places, exactly the
// precision baked into the emitted clamp() string.
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

// Direct port of the source's `build(minPx, maxPx)` closure, parameterized
// on viewport/root instead of reading them from module-level DOM inputs.
// Returns null when the two viewports are equal (division by zero avoided
// exactly as the source's `if (!(maxVw - minVw)) return null;` does).
function buildClamp(minPx, maxPx, minVw, maxVw, root) {
  if (!(maxVw - minVw)) return null;
  const slope = (maxPx - minPx) / (maxVw - minVw);
  const intercept = minPx - minVw * slope;
  const lo = Math.min(minPx, maxPx) / root;
  const hi = Math.max(minPx, maxPx) / root;
  const interceptRem = intercept / root;
  const slopeVw = slope * 100;
  const css =
    'clamp(' + String(round4(lo)) + 'rem, ' + String(round4(interceptRem)) + 'rem + ' +
    String(round4(slopeVw)) + 'vw, ' + String(round4(hi)) + 'rem)';
  return {
    css,
    minRem: round4(lo),
    maxRem: round4(hi),
    interceptRem: round4(interceptRem),
    slopeVw: round4(slopeVw),
    at(vw) {
      const v = intercept + slope * vw;
      return Math.min(Math.max(v, Math.min(minPx, maxPx)), Math.max(minPx, maxPx));
    },
  };
}

function computeClamp(input) {
  const minSizePx = input.minSizePx;
  const maxSizePx = input.maxSizePx;
  const minViewportPx = input.minViewportPx;
  const maxViewportPx = input.maxViewportPx;
  // Source: `num("root") || 16` -- an explicit 0 (or anything falsy) falls
  // back to 16, not just an absent field. Reproduced here even though the
  // schema itself already defaults an absent value to 16.
  const root = input.rootFontSizePx || 16;

  const r = buildClamp(minSizePx, maxSizePx, minViewportPx, maxViewportPx, root);
  if (!r) {
    return {
      status: 'sameViewports',
      note: STRINGS.sameVw,
      css: null,
      math: null,
      preview: [],
      scale: [],
    };
  }

  // Source checks flat before inverted: `minPx === maxPx ? flat : (maxPx < minPx ? inverted : "")`.
  let status = 'ok';
  let note = '';
  if (minSizePx === maxSizePx) {
    status = 'flat';
    note = STRINGS.flat;
  } else if (maxSizePx < minSizePx) {
    status = 'inverted';
    note = STRINGS.inverted;
  }

  const previewViewportsPx = input.previewViewportsPx || [];
  const preview = previewViewportsPx.map((vw) => ({
    viewportPx: vw,
    computedSizePx: Math.round(r.at(vw) * 100) / 100,
  }));

  const scale = [];
  if (input.typeScale) {
    // Source: `Math.max(1, Math.min(8, num("steps") || 1))`. Reproduced for
    // fidelity even though the schema's own min(1)/max(8) already keeps
    // valid callers in range.
    const steps = Math.max(1, Math.min(8, input.typeScale.steps || 1));
    const ratio = input.typeScale.ratio;
    for (let i = 0; i < steps; i++) {
      const f = Math.pow(ratio, i);
      const stepMinPx = minSizePx * f;
      const stepMaxPx = maxSizePx * f;
      const s = buildClamp(stepMinPx, stepMaxPx, minViewportPx, maxViewportPx, root);
      if (s) {
        scale.push({
          step: i + 1,
          ratioApplied: round4(f),
          minSizePx: round4(stepMinPx),
          maxSizePx: round4(stepMaxPx),
          css: s.css,
        });
      }
    }
  }

  return {
    status,
    note,
    css: r.css,
    math: {
      minRem: r.minRem,
      maxRem: r.maxRem,
      interceptRem: r.interceptRem,
      slopeVw: r.slopeVw,
    },
    preview,
    scale,
  };
}

function register(server) {
  server.registerTool(
    'css_clamp_calculator',
    {
      title: 'CSS clamp() Calculator',
      description:
        "Generates a CSS clamp() declaration (in rem) that linearly interpolates a size between a value at a small viewport width and a value at a large one, exactly matching GO AI's clamp() calculator tool (same slope/intercept math, rounded to 4 decimal places). Returns a status: 'sameViewports' when the two viewport widths are equal (no line can be drawn -- css is null), 'flat' when the min and max sizes are equal (a constant, clamp() unneeded), 'inverted' when the max size is smaller than the min (still valid CSS, but the computed size shrinks as the viewport grows), or 'ok' otherwise. Optionally evaluates the computed pixel size at a list of preview viewport widths, and optionally generates a matched fluid type scale by multiplying both endpoints by ratio^step for a given number of steps -- unlike the website's five-option dropdown, any positive ratio is accepted here since the underlying math is not limited to those presets.",
      inputSchema: {
        minSizePx: z.number().describe('Size in px at the small viewport.'),
        minViewportPx: z.number().describe('The small viewport width in px.'),
        maxSizePx: z.number().describe('Size in px at the large viewport.'),
        maxViewportPx: z.number().describe('The large viewport width in px.'),
        rootFontSizePx: z
          .number()
          .default(16)
          .describe('Root font size in px used to convert the px sizes to rem. Defaults to 16; a value of 0 also falls back to 16.'),
        previewViewportsPx: z
          .array(z.number())
          // Each entry becomes a {viewportPx, computedSizePx} object in the
          // response -- a ~20x expansion from the few input bytes that
          // produced it. A preview table is read by a human; 64 rows is
          // already more than anyone wants.
          .max(MAX_PREVIEW_VIEWPORTS)
          .optional()
          .describe(`Optional list of viewport widths (px), up to ${MAX_PREVIEW_VIEWPORTS}, to evaluate the resulting clamp() at, returned as computed pixel sizes.`),
        typeScale: z
          .object({
            steps: z.number().int().min(1).max(8).default(5).describe('Number of scale steps, 1-8.'),
            ratio: z.number().positive().default(1.2).describe('Multiplier applied per step (e.g. 1.25, a minor third).'),
          })
          .optional()
          .describe('Optional: when provided, also returns a fluid type scale of this many steps, each step scaling both endpoints by ratio^step.'),
      },
    },
    async (args) => {
      try {
        const result = computeClamp(args);
        return toolResult.ok(result);
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );
}

module.exports = { register, toolCount: 1, computeClamp, MAX_PREVIEW_VIEWPORTS };
