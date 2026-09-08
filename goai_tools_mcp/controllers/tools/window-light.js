'use strict';

const { z } = require('zod');
const toolResult = require('../../utils/toolResult');
const toolAnnotations = require('../../utils/toolAnnotations');

// Ported from nginx/sites/goai/tools/window-light.html's inline <script>,
// which keeps its UI copy in a JSON strings block (id="light-strings"). The
// values below are copied verbatim from that block so this tool's verdict,
// reasoning, and plant shortlist read exactly like the page's own output.
const S = {
  vDirect: 'Direct sun',
  vBright: 'Bright indirect',
  vMedium: 'Medium light',
  vLow: 'Low light',
  vNone: 'Too dark for most plants',
  sDirect: 'Hours of sun landing on the leaves.',
  sBright: 'What most houseplant labels are asking for.',
  sMedium: 'Enough for the tolerant, slow going for the rest.',
  sLow: 'Survival light. Growth will be slow and leggy.',
  sNone: 'Below what a leaf can live on for long.',
  aSun: 'This is the bright side of the building: sun for much of the day, and the strongest light any window here will give.',
  aSunSide: 'It catches the sun for part of the day and stays bright for the rest of it.',
  aEast: 'Morning sun, then even light — gentle enough that few plants burn on the sill.',
  aWest: 'Shade in the morning, then hot afternoon sun that comes in low and strong.',
  aPoleSide: 'Some sun at the edges of the day in summer, and little for the rest of the year.',
  aPole: 'No direct sun at all. Even, shadowless light, which is easy on leaves but never strong.',
  bClear: 'Nothing is cutting it down.',
  bSheer: 'What is in the way takes off roughly a third and softens what gets through.',
  bNear: 'What is in the way takes off about half of it.',
  bHeavy: 'Most of it is blocked before it reaches the glass.',
  dSill: 'On the sill the plant gets the full view of the sky.',
  d1Note: "An arm's length back already costs about half.",
  d2Note: 'A metre or two back, only a third is left — the window looks small from there.',
  d3Note: 'Three metres back is a fifth of what the sill gets, whatever the direction.',
  d4Note: 'That far in, the window is a small bright rectangle and most of the light in the room is bounced off the walls.',
  scorch: 'Watch the afternoon in summer: direct west sun through glass will scorch leaves that would be fine outdoors.',
  pDirect: 'Suits: succulents and cacti, jade, aloe, ponytail palm, string of pearls.',
  pBright: 'Suits: monstera, fiddle-leaf fig, rubber plant, hoya, bird of paradise.',
  pMedium: 'Suits: pothos, philodendron, peace lily, spider plant, dracaena.',
  pLow: 'Suits: ZZ plant, snake plant, cast-iron plant, Chinese evergreen.',
  pNone: 'Nothing will thrive here. A ZZ plant or snake plant will hold on, or add a grow light.',
};

// Points for an unobstructed sill, northern hemisphere. West sits above east
// because afternoon sun is stronger and comes in lower. Exact copy of the
// source's SUN/BLOCK/DIST/BANDS/ASPECT_NOTE tables.
const SUN = { S: 4, SE: 3.4, SW: 3.5, E: 2.6, W: 2.8, NE: 1.8, NW: 1.9, N: 1.5 };
const BLOCK = { clear: 1, sheer: 0.68, near: 0.45, heavy: 0.22 };
const DIST = { sill: 1, d1: 0.55, d2: 0.32, d3: 0.19, d4: 0.09 };
const BANDS = [
  [3, 'Direct'],
  [1.6, 'Bright'],
  [0.7, 'Medium'],
  [0.25, 'Low'],
  [0, 'None'],
];
const ASPECT_NOTE = {
  S: 'aSun',
  SE: 'aSunSide',
  SW: 'aSunSide',
  E: 'aEast',
  W: 'aWest',
  NE: 'aPoleSide',
  NW: 'aPoleSide',
  N: 'aPole',
};

// Exact port of the source's solar(): south of the equator the sun crosses
// the northern sky, so the compass point a guide calls "bright" is the
// opposite one. East and west are untouched — the sun still rises and sets
// where it always did.
function solarAspectOf(aspect, hemisphere) {
  if (hemisphere === 'north') return aspect;
  return aspect
    .split('')
    .map((c) => (c === 'N' ? 'S' : c === 'S' ? 'N' : c))
    .join('');
}

// Exact port of the source's BANDS lookup: first entry (highest threshold
// first) whose threshold the score clears. Score is always > 0 here (every
// SUN/BLOCK/DIST factor is positive), so the [0, 'None'] entry always
// matches as the catch-all floor.
function bandFor(score) {
  const hit = BANDS.find((b) => score >= b[0]);
  return hit[1];
}

function estimateWindowLight(input) {
  const { hemisphere, aspect, blocked, distance } = input;
  const solarAspect = solarAspectOf(aspect, hemisphere);
  const score = SUN[solarAspect] * BLOCK[blocked] * DIST[distance];
  const band = bandFor(score);

  const verdict = S['v' + band];
  const verdictSub = S['s' + band];

  const blockedKey = 'b' + blocked.charAt(0).toUpperCase() + blocked.slice(1);
  const reasoningParts = [
    S[ASPECT_NOTE[solarAspect]],
    S[blockedKey],
    distance === 'sill' ? S.dSill : S[distance + 'Note'],
  ];
  // West sun burns leaves well before the score calls it "direct", so this
  // warning follows the (solar-adjusted) aspect rather than the band —
  // exact port of the source's post-hemisphere-flip check.
  if ((solarAspect === 'W' || solarAspect === 'SW') && blocked === 'clear' && distance === 'sill') {
    reasoningParts.push(S.scorch);
  }
  const reasoning = reasoningParts.join(' ');
  const plants = S['p' + band];

  return {
    // Rounded to 4dp for a readable output field only — banding above uses
    // the raw, unrounded product, exactly as the source's run() does.
    score: Math.round(score * 10000) / 10000,
    band,
    // Not in the hint's output shape, but included alongside solarAspect so
    // a caller can tell whether the hemisphere flip actually changed
    // anything for this input.
    aspect,
    solarAspect,
    verdict,
    verdictSub,
    reasoning,
    plants,
  };
}

const inputSchema = {
  hemisphere: z
    .enum(['north', 'south'])
    .describe(
      "Hemisphere the window is in. South of the equator the sun tracks the northern sky, so the compass direction that gets the strongest light is reversed from what most (northern-hemisphere-written) plant guides assume."
    ),
  aspect: z
    .enum(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'])
    .describe('True compass direction the window faces (before any hemisphere adjustment).'),
  blocked: z
    .enum(['clear', 'sheer', 'near', 'heavy'])
    .describe(
      "What stands between the glass and the open sky: 'clear' = nothing, 'sheer' = a net curtain/blind or distant trees, 'near' = a tree or building close by, 'heavy' = mostly blocked."
    ),
  distance: z
    .enum(['sill', 'd1', 'd2', 'd3', 'd4'])
    .describe(
      "How far back from the glass the plant sits: 'sill' = on the sill, 'd1' = within an arm's reach, 'd2' = one to two metres back, 'd3' = two to three metres back, 'd4' = further into the room."
    ),
};

// The shape of the JSON in structuredContent. Declared so an agent can
// read the result without parsing prose -- and, because the SDK validates
// every success against it, so a handler that quietly stops returning a
// field fails here instead of downstream. Nullable fields below are the
// ones the computation genuinely leaves empty, not defensive padding.
const windowLightOutputSchema = {
  score: z.number().describe('The computed light score the band and verdict are derived from -- higher is brighter.'),
  band: z.string().describe('The score bucketed into a named light level, the single field most callers want.'),
  aspect: z.string().describe('The compass direction the window faces, echoed from the input.'),
  solarAspect: z
    .string()
    .describe('That aspect mapped to its solar equivalent for the given hemisphere -- a south-facing window means the opposite thing north and south of the equator.'),
  verdict: z.string().describe('One-line summary of what this window is good for.'),
  verdictSub: z.string().describe('A supporting line qualifying the verdict.'),
  reasoning: z.string().describe('Why the score came out where it did, naming the aspect, glazing and distance contributions.'),
  plants: z.string().describe('Plant types suited to this light level.'),
};

function register(server) {
  server.registerTool(
    'estimate_window_light',
    {
      title: 'Window light estimator for houseplants',
      description:
        "Estimates the indoor light level a window gives a plant, in the category words houseplant care guides use (Direct sun / Bright indirect / Medium light / Low light / Too dark), from the window's hemisphere, compass aspect, what obstructs it, and how far back the plant sits from the glass. This is a small heuristic scoring table ported from GO AI's window-light tool page, not a physical light-meter reading or a per-location sun-position model — it correctly flips which compass direction is 'bright' for the southern hemisphere and flags the direct-west-sun scorch risk, and returns the reasoning behind the verdict plus a shortlist of plants suited to that light level.",
      annotations: toolAnnotations.PURE,
      outputSchema: windowLightOutputSchema,
      inputSchema,
    },
    async (args) => {
      try {
        const result = estimateWindowLight(args);
        return toolResult.ok(result);
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );
}

module.exports = { register, toolCount: 1, estimateWindowLight, solarAspectOf, bandFor, inputSchema };
