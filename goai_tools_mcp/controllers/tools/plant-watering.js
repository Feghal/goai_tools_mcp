'use strict';

const { z } = require('zod');
const toolResult = require('../../utils/toolResult');
const icsWriter = require('../../utils/icsWriter');
const DATA = require('../../utils/data/plant-watering.json');

// Ported from nginx/sites/goai/tools/watering.html's inline <script>, which
// keeps its data in three <script type="application/json"> blocks
// (water-plants, water-factors, water-strings). Merged here into one data
// file (utils/data/plant-watering.json) since the source's "plants" and
// "strings" blocks are really one table (id -> {baseDays, displayName}).
const PLANTS = DATA.plants; // id -> { name, baseDays }
const PLANT_IDS = Object.keys(PLANTS); // 32 ids, source declaration order

function factorMap(name) {
  const map = {};
  DATA.factors[name].forEach(([value, f]) => {
    map[value] = f;
  });
  return map;
}
const POT_SIZE_FACTORS = factorMap('potSize');
const POT_MATERIAL_FACTORS = factorMap('potMaterial');
const LIGHT_FACTORS = factorMap('light');
const SEASON_FACTORS = factorMap('season');

// Source: `$('season').value = [...12 entries indexed by getMonth()][today.getMonth()]`,
// with the comment "Northern-hemisphere meteorological seasons; the control
// is there to be overridden by anyone the guess is wrong for." The task hint
// this file started from marked `season` as a required input, but the page
// itself never requires it — it only ever defaults from the clock. Ported
// as optional here, defaulting the same way, so a caller in the southern
// hemisphere (or planning ahead) overrides it explicitly instead.
const MONTH_TO_SEASON = [
  'winter', 'winter', 'spring', 'spring', 'spring', 'summer',
  'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter',
];
function seasonForDate(date) {
  return MONTH_TO_SEASON[date.getMonth()];
}

function pad2(n) {
  return String(n).padStart(2, '0');
}
// Same shape as the source's iso(): local-time Y-M-D, not UTC — matches
// what an HTML <input type="date"> would hold for "today".
function isoDate(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidCalendarDate(str) {
  if (!DATE_RE.test(str)) return false;
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Exact port of the source's intervalFor():
//   Math.max(2, Math.round(PLANTS[key].days * multiplier()))
function intervalDaysFor(baseDays, multiplier) {
  return Math.max(2, Math.round(baseDays * multiplier));
}

// input: { plants, potSize?, potMaterial?, light?, season?, startDate? }
// now: injectable "current time", defaults to `new Date()` — used for the
// season default, the startDate default, and the .ics DTSTAMP.
function computeWateringCalendar(input, now) {
  now = now || new Date();

  const potSize = input.potSize || 'medium';
  const potMaterial = input.potMaterial || 'plastic';
  const light = input.light || 'indirect';
  const season = input.season || seasonForDate(now);

  const startDate = input.startDate || isoDate(now);
  if (!isValidCalendarDate(startDate)) {
    throw new Error(`startDate "${input.startDate}" is not a real calendar date in YYYY-MM-DD form.`);
  }

  // Dedupe while preserving first-occurrence order — mirrors the source's
  // `chosen` object, which is keyed by plant id (so re-clicking a plant in
  // the UI *removes* it; that toggle gesture has no equivalent in a
  // one-shot API call, so a caller repeating an id here just gets it once).
  const seen = new Set();
  const chosenKeys = [];
  input.plants.forEach((key) => {
    if (!seen.has(key)) {
      seen.add(key);
      chosenKeys.push(key);
    }
  });

  const multiplier =
    POT_SIZE_FACTORS[potSize] * POT_MATERIAL_FACTORS[potMaterial] * LIGHT_FACTORS[light] * SEASON_FACTORS[season];
  const multiplierRounded = round2(multiplier);

  // Source sorts the results table by computed interval, ascending.
  const schedule = chosenKeys
    .map((key) => {
      const baseDays = PLANTS[key].baseDays;
      return {
        key,
        name: PLANTS[key].name,
        intervalDays: intervalDaysFor(baseDays, multiplier),
        baseDays,
        multiplier: multiplierRounded,
      };
    })
    .sort((a, b) => a.intervalDays - b.intervalDays);

  const intervalValues = schedule.map((row) => row.intervalDays);
  const summary = {
    chosenCount: chosenKeys.length,
    minIntervalDays: Math.min(...intervalValues),
    maxIntervalDays: Math.max(...intervalValues),
    seasonFactor: SEASON_FACTORS[season],
  };

  // The .ics event order follows the *original* selection order (source:
  // `Object.keys(chosen).forEach` in ics(), which is insertion order), not
  // the interval-sorted table order built above (that sort only happens in
  // render(), for display) — so UID indices and event order below are taken
  // from chosenKeys directly, not from `schedule`.
  const dtstart = startDate.replace(/-/g, '');
  const events = chosenKeys.map((key, i) => {
    const n = intervalDaysFor(PLANTS[key].baseDays, multiplier);
    const name = PLANTS[key].name;
    return {
      uid: `${dtstart}-${i}-${key}@goai.tools`,
      dtstartDate: dtstart,
      rrule: `FREQ=DAILY;INTERVAL=${n}`,
      summary: `Check ${name}`,
      description: `Put a finger in the soil. Water only if the top few centimetres are dry. Interval: every ${n} days.`,
    };
  });
  const icsText = icsWriter.buildVCalendar({
    prodId: '-//GO AI//Plant watering calendar//EN',
    calName: 'Plant watering',
    events,
    now,
  });

  return {
    schedule,
    summary,
    calendar: {
      filename: 'plant-watering.ics',
      mimeType: 'text/calendar;charset=utf-8',
      icsText,
    },
    // Not in the original hint's output shape, but the source keeps this
    // exact line pinned under the results table at all times — worth
    // surfacing so a client relays it instead of treating the intervals as
    // a measured fact rather than a "go check" prompt.
    note: 'Each event is a reminder to check the soil. If the top few centimetres are still damp, close it and wait.',
  };
}

// A full z.object() rather than a raw shape, purely so tests can import and
// .safeParse() against it directly (both forms are accepted by
// server.registerTool() with this SDK version) -- there is no cross-field
// rule here to justify a .refine().
const inputSchema = z.object({
  plants: z
    .array(z.enum(PLANT_IDS))
    .min(1, 'Choose at least one plant.')
    // The enum bounds each ENTRY's value but not the array's LENGTH, and the
    // dedupe loop, the schedule map and the .ics event build each run once per
    // entry before duplicates are collapsed. There are only PLANT_IDS.length
    // distinct plants, so anything past that is pure repetition -- the catalog
    // size is the natural cap.
    .max(PLANT_IDS.length, `At most ${PLANT_IDS.length} plants (the whole catalog); duplicates are ignored.`)
    .describe(
      `Houseplant ids to include (each event uses this exact catalog, no free text). Duplicates are ignored. Ids: ${PLANT_IDS.join(', ')}.`
    ),
  potSize: z
    .enum(['small', 'medium', 'large'])
    .optional()
    .default('medium')
    .describe('Pot diameter band: small (under 12cm), medium (12-25cm, default), large (over 25cm). A larger pot holds more soil and dries more slowly.'),
  potMaterial: z
    .enum(['terracotta', 'plastic', 'glazed'])
    .optional()
    .default('plastic')
    .describe('Unglazed terracotta breathes and dries noticeably faster than plastic (default) or glazed ceramic.'),
  light: z
    .enum(['bright', 'indirect', 'low'])
    .optional()
    .default('indirect')
    .describe('Light level: bright direct sun dries soil fastest, low light slowest. Defaults to bright-but-indirect.'),
  season: z
    .enum(['spring', 'summer', 'autumn', 'winter'])
    .optional()
    .describe(
      "Current season, which scales every interval (summer fastest, winter roughly 60% slower). If omitted, defaults from today's calendar month assuming the *northern* hemisphere, exactly like the source page -- pass this explicitly for a southern-hemisphere season or to plan for a season other than the current one."
    ),
  startDate: z
    .string()
    .regex(DATE_RE, 'startDate must be in YYYY-MM-DD form')
    .optional()
    .describe("First reminder date, YYYY-MM-DD. Every plant's recurring event starts on this same date, each with its own repeat interval. Defaults to today."),
});

function register(server) {
  server.registerTool(
    'plant_watering_calendar',
    {
      title: 'Plant watering calendar (.ics)',
      description:
        "Builds a soil-check interval per houseplant from a fixed drought-tolerance table (32 common houseplants), adjusted by pot size, pot material, light and season, and returns both a schedule breakdown and the full text of a downloadable RFC 5545 .ics calendar file -- one recurring all-day 'check the soil' reminder per plant (deliberately never 'water', since only the plant's own soil can say that). Matches GO AI's browser watering-calendar tool exactly, including its northern-hemisphere-season default when `season` is omitted, its terracotta/glazed/low-light/winter multipliers, and its 75-octet .ics line folding. The starting intervals are heuristic drought-tolerance bands, not a measurement of any specific plant, pot or room -- the tool says so in its own FAQ.",
      inputSchema,
    },
    async (args) => {
      try {
        const result = computeWateringCalendar(args);
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
  computeWateringCalendar,
  intervalDaysFor,
  seasonForDate,
  isoDate,
  PLANT_IDS,
  inputSchema,
};
