'use strict';

const { computeBpmDelay } = require('../controllers/tools/bpm');

describe('computeBpmDelay', () => {
  test('typical case: direct bpm, default 4/4 signature, bars -> seconds', () => {
    // Source: paint() + fromBars(), bpm = 120.
    // quarter = 60000 / 120 = 500 ms.
    // d=4:  ms = 500*4/4 = 500;   dotted = 750;   triplet = 500*2/3 = 333.333.. -> 333.3; hz = 1000/500 = 2
    // d=8:  ms = 500*4/8 = 250;   dotted = 375;   triplet = 250*2/3 = 166.666.. -> 166.7; hz = 1000/250 = 4
    // bar  = beats(4) * (60/120) * (4/unit(4)) = 4 * 0.5 * 1 = 2 seconds/bar
    // bars(32) -> seconds = round(32 * 2, 2) = 64
    const result = computeBpmDelay({ bpm: 120, bars: 32 });

    expect(result.bpm).toBe(120);
    expect(result.bpmSource).toBe('direct');
    expect(result.timeSignature).toEqual({ beats: 4, unit: 4, label: '4/4' });
    expect(result.barDurationSeconds).toBe(2);
    expect(result.bars).toBe(32);
    expect(result.seconds).toBe(64);

    const quarterRow = result.delayTable.find((r) => r.division === 4);
    expect(quarterRow).toEqual({ division: 4, label: '1/4', straightMs: 500, dottedMs: 750, tripletMs: 333.3, hz: 2 });

    const eighthRow = result.delayTable.find((r) => r.division === 8);
    expect(eighthRow).toEqual({ division: 8, label: '1/8', straightMs: 250, dottedMs: 375, tripletMs: 166.7, hz: 4 });
  });

  test('edge case: two taps whose median-filtered interval set empties out throws (documented source behavior)', () => {
    // Source: tap() feeds intervals into tempoFrom(). With intervals [10, 1000]:
    // sorted = [10, 1000], n=2 (even) -> mid = (10+1000)/2 = 505
    // kept = intervals within 505*0.5=252.5 of 505: |10-505|=495 (excluded), |1000-505|=495 (excluded)
    // kept = [] -> sum/length = 0/0 = NaN -> bpm = 60000/NaN = NaN
    // The live page would render "NaN"; the tool must fail cleanly instead.
    expect(() => computeBpmDelay({ tapTimesMs: [0, 10, 1010] })).toThrow(/too inconsistent/);
  });

  test('cross-field validation: exactly one of bpm/tapTimesMs/tapIntervalsMs is required', () => {
    expect(() => computeBpmDelay({})).toThrow(/exactly one of/);
    expect(() => computeBpmDelay({ bpm: 120, tapTimesMs: [0, 500, 1000] })).toThrow(/exactly one of/);
  });

  test('resolves tempo from evenly spaced tap intervals', () => {
    // intervals [500, 500, 500] -> sorted median (odd, n=3) = 500
    // kept = all three (within 250 of 500) -> avg = 500 -> bpm = 60000/500 = 120
    // Math.round(120 * 10) / 10 = 120 (the value fed into every downstream calc)
    const result = computeBpmDelay({ tapIntervalsMs: [500, 500, 500] });

    expect(result.bpmSource).toBe('taps');
    expect(result.bpm).toBe(120);
    expect(result.tapDiagnostics.rawBpm).toBeCloseTo(120, 10);
    expect(result.tapDiagnostics.sessionTapCount).toBe(4); // 4 taps from 3 intervals
    expect(result.tapDiagnostics.intervalsMs).toEqual([500, 500, 500]);
    expect(result.tapDiagnostics.sessionResets).toBe(0);
  });

  test('custom time signature: seconds -> bars conversion (fromSeconds direction)', () => {
    // bar = beats(3) * (60/90) * (4/unit(8)) = 3 * (2/3) * (1/2) = 1 second/bar exactly
    // seconds(10) -> bars = round(10 / 1, 2) = 10
    const result = computeBpmDelay({ bpm: 90, timeSignature: { beats: 3, unit: 8 }, seconds: 10 });

    expect(result.timeSignature).toEqual({ beats: 3, unit: 8, label: '3/8' });
    expect(result.barDurationSeconds).toBe(1);
    expect(result.seconds).toBe(10);
    expect(result.bars).toBe(10);
  });
});
