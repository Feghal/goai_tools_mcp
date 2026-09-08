'use strict';

// Port of nginx/sites/goai/tools/bpm.html's inline <script> (tap tempo +
// delay/LFO table + bars<->seconds conversion). Every formula and rounding
// rule below is copied line-for-line from that source; see the comment next
// to each one for the corresponding line of JS it mirrors.

const { z } = require('zod');
const toolResult = require('../../utils/toolResult');
const toolAnnotations = require('../../utils/toolAnnotations');

// SIGS in the source, in the exact order the <select> lists them.
const SIG_PRESETS = ['4/4', '3/4', '2/4', '6/8', '5/4', '7/8', '12/8'];
// DIVISIONS in the source.
const DEFAULT_DIVISIONS = [1, 2, 4, 8, 16, 32];
// GAP in the source: a pause this long (ms) starts a fresh tapping session.
const GAP = 2000;

// Output amplifiers. `divisions` is the worst: each entry becomes one
// delayTable row of five fields plus a label string (~150 bytes of result
// object), from about two bytes of input ("8,"). 64 divisions is far more
// than the six the source ships and more than any delay table is read at.
const MAX_DIVISIONS = 64;

// Taps: the source's own algorithm only ever keeps the last 9 (8 intervals),
// so everything beyond that is discarded anyway -- but the pre-trim loop, the
// strictly-increasing check, and `tapDiagnostics.intervalsMs` (which echoes
// one entry per interval back to the caller) all run over the full array
// first. 4096 is minutes of continuous tapping.
const MAX_TAPS = 4096;

function round(n, places) {
  // Same math as the source's round(n, places); the source additionally
  // calls .toLocaleString() on the result, which is a display-formatting
  // step (thousands separators) that has no place in a JSON API response,
  // so it is intentionally dropped here — the numeric value is identical.
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

// Exact port of tempoFrom(intervals): median-filtered outlier rejection,
// then bpm from the mean of whatever survives the filter.
function tempoFrom(intervals) {
  const mid = median(intervals);
  const kept = intervals.filter((v) => Math.abs(v - mid) <= mid * 0.5);
  const sum = kept.reduce((a, b) => a + b, 0);
  return 60000 / (sum / kept.length);
}

// Resolves the time signature input into the {beats, unit} pair the source's
// beatsPerBar() reads straight off the <select> value, plus a display label.
// The source only ever offers the 7 SIG_PRESETS through its <select>, but its
// formula (beatsPerBar + the bar-length arithmetic) is generic over any
// {beats, unit} pair, so a custom pair is accepted here too — not a
// deviation from the source's math, just from its fixed picklist.
function resolveTimeSignature(timeSignature) {
  if (timeSignature === undefined) return { beats: 4, unit: 4, label: '4/4' };
  if (typeof timeSignature === 'string') {
    const [beats, unit] = timeSignature.split('/').map(Number);
    return { beats, unit, label: timeSignature };
  }
  return { beats: timeSignature.beats, unit: timeSignature.unit, label: `${timeSignature.beats}/${timeSignature.unit}` };
}

// Resolves the tempo to use, mirroring tap()/paint() together — including a
// detail that is easy to miss reading only paint(): when the tempo comes
// from taps, tap() writes Math.round(bpm * 10) / 10 into the #bpm input
// *before* calling paint(), so every downstream calculation (the delay
// table, bar length, bars<->seconds) runs on the rounded-to-0.1 value, not
// the raw computed tempo. A directly-supplied bpm is used unrounded, exactly
// as paint() reads it straight off the input with no rounding applied.
function resolveTempo(input) {
  const provided = ['bpm', 'tapTimesMs', 'tapIntervalsMs'].filter((k) => input[k] !== undefined);
  if (provided.length !== 1) {
    throw new Error('Provide exactly one of bpm, tapTimesMs, or tapIntervalsMs.');
  }

  if (input.bpm !== undefined) {
    return { bpm: input.bpm, bpmSource: 'direct' };
  }

  let times;
  if (input.tapTimesMs !== undefined) {
    times = input.tapTimesMs;
    for (let i = 1; i < times.length; i++) {
      if (times[i] <= times[i - 1]) {
        throw new Error('tapTimesMs must be strictly increasing millisecond timestamps, in tap order.');
      }
    }
  } else {
    // tapIntervalsMs is the gap-since-previous-tap for each tap after the
    // first; reconstruct a synthetic timestamp sequence from it so the same
    // gap-reset / rolling-window logic below applies identically to both
    // input shapes.
    times = [0];
    for (const gap of input.tapIntervalsMs) times.push(times[times.length - 1] + gap);
  }

  // Exact port of the running state tap() keeps across calls: reset the
  // whole session on a pause > GAP, and cap it at the last 9 taps (8
  // intervals) — "this averages the last eight intervals" per the source's
  // own comment.
  let taps = [];
  let sessionResets = 0;
  for (const now of times) {
    if (taps.length && now - taps[taps.length - 1] > GAP) {
      taps = [];
      sessionResets++;
    }
    taps.push(now);
    if (taps.length > 9) taps.shift();
  }

  if (taps.length < 2) {
    // Mirrors the source's "keepTapping" state (taps.length < 2 → no tempo
    // yet) — but an API call has no follow-up tap to wait for, so this is a
    // reportable failure rather than a UI status message.
    throw new Error('Not enough taps in the final session (taps within 2000 ms of each other) to compute a tempo — at least 2 are required.');
  }

  const intervals = [];
  for (let i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i - 1]);
  const rawBpm = tempoFrom(intervals);

  // A documented edge case in the source's own algorithm, not a bug we're
  // introducing: with only 2 taps whose single-interval "median" sits
  // roughly halfway between two very different values, the outlier filter
  // (kept within 50% of the median) can reject every interval, leaving
  // kept.length === 0 and bpm = 60000 / (0/0) = NaN. The live page would
  // silently render "NaN" into the tempo readout; an API caller gets a
  // clean failure instead.
  if (!isFinite(rawBpm) || rawBpm <= 0) {
    throw new Error('Tap intervals were too inconsistent for the median-filtered outlier rejection to settle on a tempo — try steadier taps.');
  }

  const bpm = Math.round(rawBpm * 10) / 10; // Math.round(bpm * 10) / 10, written into #bpm before paint() runs.

  return {
    bpm,
    bpmSource: 'taps',
    tapDiagnostics: {
      tapsProvided: times.length,
      sessionTapCount: taps.length,
      sessionResets,
      intervalsMs: intervals,
      medianIntervalMs: median(intervals),
      rawBpm,
    },
  };
}

// The pure calculator: resolves tempo + time signature, then builds the
// delay/LFO table and (optionally) the bars<->seconds conversion, exactly
// per paint()/fromBars()/fromSeconds().
function computeBpmDelay(input) {
  const { bpm, bpmSource, tapDiagnostics } = resolveTempo(input);
  const sig = resolveTimeSignature(input.timeSignature);
  const divisions = input.divisions && input.divisions.length ? input.divisions : DEFAULT_DIVISIONS;

  const quarterMs = 60000 / bpm; // quarter = 60000 / bpm
  const delayTable = divisions.map((d) => {
    // A whole note is four quarters, so a 1/d note is 4/d quarters long.
    const ms = (quarterMs * 4) / d;
    return {
      division: d,
      label: `1/${d}`,
      straightMs: round(ms, 1),
      dottedMs: round(ms * 1.5, 1),
      tripletMs: round((ms * 2) / 3, 1),
      hz: round(1000 / ms, 3),
    };
  });

  // bar = beats * (60 / bpm) * (4 / unit) — exact port of the shared
  // expression in paint(), fromBars() and fromSeconds().
  const barDurationSeconds = sig.beats * (60 / bpm) * (4 / sig.unit);

  const result = {
    bpm,
    bpmSource,
    timeSignature: sig,
    barDurationSeconds: round(barDurationSeconds, 6),
    delayTable,
  };
  if (tapDiagnostics) result.tapDiagnostics = tapDiagnostics;

  // bars and seconds are independently optional in the source (typing into
  // either box recomputes the other). An API call isn't a sequence of typing
  // events, so when both are given, bars — the fromBars() direction — wins;
  // this is an editorial choice for the ambiguous case, not a source rule.
  if (input.bars !== undefined) {
    result.bars = input.bars;
    result.seconds = round(input.bars * barDurationSeconds, 2); // Math.round(seconds * 100) / 100
  } else if (input.seconds !== undefined) {
    result.seconds = input.seconds;
    result.bars = round(input.seconds / barDurationSeconds, 2); // Math.round(bars * 100) / 100
  }

  return result;
}

// The shape of the JSON in structuredContent. Declared so an agent can
// read the result without parsing prose -- and, because the SDK validates
// every success against it, so a handler that quietly stops returning a
// field fails here instead of downstream. Nullable fields below are the
// ones the computation genuinely leaves empty, not defensive padding.
const bpmOutputSchema = {
  bpm: z.number().describe('The tempo the table was computed at, in beats per minute.'),
  bpmSource: z
    .string()
    .describe('Where that tempo came from: given directly, or averaged from tap times or tap intervals -- worth surfacing, since a tapped tempo carries the tapper\'s error.'),
  timeSignature: z
    .object({
      beats: z.number().int().describe('Beats per bar (the numerator).'),
      unit: z.number().int().describe('Note value that gets the beat (the denominator).'),
      label: z.string().describe("The signature written out, e.g. '4/4'."),
    })
    .describe('The time signature used to size a bar.'),
  barDurationSeconds: z.number().describe('Length of one bar in seconds at this tempo and signature.'),
  delayTable: z
    .array(
      z.object({
        division: z.number().int().describe('The note division, as its denominator (4 = quarter note, 8 = eighth, and so on).'),
        label: z.string().describe('That division written out.'),
        straightMs: z.number().describe('Delay time in milliseconds for the straight note.'),
        dottedMs: z.number().describe('Dotted variant: 1.5x the straight time.'),
        tripletMs: z.number().describe('Triplet variant: two thirds of the straight time.'),
        hz: z.number().describe('The same interval expressed as a frequency, for setting an LFO rate rather than a delay.'),
      })
    )
    .describe('One row per requested division, each with straight, dotted and triplet timings.'),
  // Both keys are absent unless the caller asked for the conversion by
  // supplying one of them -- the handler sets the pair or neither.
  bars: z
    .number()
    .optional()
    .describe('The bar count that seconds corresponds to. Present only when bars or seconds was supplied.'),
  seconds: z
    .number()
    .optional()
    .describe('Duration in seconds of that many bars at this tempo. Present only when bars or seconds was supplied.'),
};

function register(server) {
  server.registerTool(
    'bpm_delay_calculator',
    {
      title: 'BPM tap tempo & delay time calculator',
      description:
        "Resolves a musical tempo — either a direct BPM, or a set of tap timestamps/intervals run through the same median-filtered outlier rejection and 2-second session-reset logic as GO AI's tap-tempo tool — then returns the full straight/dotted/triplet delay and LFO-rate table (ms and Hz) for a set of note divisions, plus bar-length and bars<->seconds conversion for a time signature. All arithmetic (not a real audio engine) — useful for setting delay/reverb/LFO times to a track's tempo.",
      annotations: toolAnnotations.PURE,
      outputSchema: bpmOutputSchema,
      inputSchema: {
        bpm: z.number().positive().optional().describe('Tempo in beats per minute, used directly and unrounded. Provide exactly one of bpm, tapTimesMs, or tapIntervalsMs.'),
        tapTimesMs: z
          .array(z.number())
          .min(2)
          .max(MAX_TAPS)
          .optional()
          .describe(`Strictly increasing millisecond timestamps of taps (e.g. from a high-resolution clock), in tap order, up to ${MAX_TAPS}. Provide exactly one of bpm, tapTimesMs, or tapIntervalsMs.`),
        tapIntervalsMs: z
          .array(z.number().positive())
          .min(1)
          .max(MAX_TAPS)
          .optional()
          .describe(`Milliseconds between each tap and the one before it (one fewer entry than the number of taps), up to ${MAX_TAPS}. Provide exactly one of bpm, tapTimesMs, or tapIntervalsMs.`),
        timeSignature: z
          .union([
            z.enum(SIG_PRESETS),
            z.object({ beats: z.number().int().positive(), unit: z.number().int().positive() }),
          ])
          .optional()
          .describe('One of "4/4","3/4","2/4","6/8","5/4","7/8","12/8" (the site\'s presets), or a custom {beats, unit} pair. Defaults to 4/4. Uses the written beat count — 6/8 is 6 beats of an eighth-note unit, not 2 dotted-quarter beats.'),
        bars: z.number().positive().optional().describe('Number of bars to convert to seconds. At most one of bars/seconds is used if both are given (bars takes priority).'),
        seconds: z.number().positive().optional().describe('Number of seconds to convert to bars. Ignored if bars is also given.'),
        divisions: z
          .array(z.number().int().positive())
          .min(1)
          .max(MAX_DIVISIONS)
          .optional()
          .describe(`Note divisions (denominator of 1/d) to include in the delay table, up to ${MAX_DIVISIONS}. Defaults to [1,2,4,8,16,32].`),
      },
    },
    async (args) => {
      try {
        const result = computeBpmDelay(args);
        return toolResult.ok(result);
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );
}

module.exports = { register, toolCount: 1, computeBpmDelay, MAX_DIVISIONS, MAX_TAPS };
