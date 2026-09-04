'use strict';

const toolPath = require.resolve('../controllers/tools/goal-date');
const { computeGoalDateProjection, mifflinStJeorBmr, addDaysIso } = require(toolPath);

// The cross-field rules (unit-conditional height fields, goalWeight <
// currentWeight) live in the zod schema passed to server.registerTool, not
// in computeGoalDateProjection itself. Re-derive it the same way register()
// does, by invoking register() against a stub server and capturing what it
// registers -- same technique as __tests__/tdee.test.js's getRegisteredSchema().
function getRegisteredSchema() {
  let captured = null;
  const stubServer = {
    registerTool(name, config) {
      captured = config.inputSchema;
    },
  };
  require(toolPath).register(stubServer);
  return captured;
}

describe('computeGoalDateProjection', () => {
  test('typical case: metric male, tiny 0.1kg gap so the whole day-by-day simulation is hand-checkable', () => {
    // bmr(80, 180, 30, male) = 10*80 + 6.25*180 - 5*30 + 5 = 800+1125-150+5 = 1780
    // maintenance = 1780 * 1.55 = 2759
    // intake = 2759 - 500 = 2259 (>= 1500 floor, proceeds)
    // settle = (2259/1.55 - (6.25*180 - 150 + 5)) / 10
    //        = (1457.419354838... - 980) / 10 = 47.7419354838... -> round1 47.7
    // reachable: 79.9 > 47.74 -> true, horizonDays = 1825
    //
    // Day-by-day simulation (kg -= (bmr(kg)*1.55 - 2259) / 7700):
    //   day1: bmr(80)=1780, delta=(2759-2259)/7700=500/7700=0.0649350649...
    //         kg = 80 - 0.0649350649... = 79.9350649350649...  (>79.9, loop continues)
    //   day2: bmr(79.93506493506493)=10*79.93506493506493+980=1779.3506493506493
    //         maintenance2=1779.3506493506493*1.55=2757.9935064935064
    //         delta=(2757.9935064935064-2259)/7700=0.06479136...
    //         kg = 79.93506493506493 - 0.06479136... = 79.87027357...  (<=79.9 -> loop stops)
    // -> daysToGoal = 2, reachedWithinHorizon = true
    //
    // naiveDays = (80-79.9)*7700/500 = 0.1*7700/500 = 770/500 = 1.54
    // gapDays = round(2 - 1.54) = round(0.46) = 0  -> "same" note (gap < 2)
    // weeksToGoal = round(2/7) = 0; naiveWeeks = round(1.54/7) = round(0.22) = 0
    // series: days never hits a multiple of 7 within the 2-day run, so only
    //   the seed entry (week 0, start weight) is ever pushed.
    // naiveLineEndWeek = naiveDays/7 = 1.54/7 = 0.22
    const result = computeGoalDateProjection({
      sex: 'male',
      age: 30,
      units: 'metric',
      heightCm: 180,
      currentWeight: 80,
      goalWeight: 79.9,
      activityLevel: 'moderate',
      dailyDeficitKcal: 500,
      referenceDate: '2026-01-01',
      includeChartSeries: true,
    });

    expect(result.status).toBe('reached');
    expect(result.maintenanceKcal).toBe(2759);
    expect(result.intakeKcal).toBe(2259);
    expect(result.floorKcal).toBe(1500);
    expect(result.activityMultiplier).toBe(1.55);
    expect(result.settleWeightKg).toBeCloseTo(47.7, 5);
    expect(result.plateau).toBe(false);
    expect(result.reachedWithinHorizon).toBe(true);
    expect(result.horizonDays).toBe(1825);
    expect(result.daysToGoal).toBe(2);
    expect(result.weeksToGoal).toBe(0);
    expect(result.naiveDays).toBeCloseTo(1.54, 5);
    expect(result.naiveWeeks).toBe(0);
    expect(result.gapDays).toBe(0);
    expect(result.projectedDate).toBe('2026-01-03');
    expect(result.note).toBe('At this deficit the two answers are within a day of each other.');
    expect(result.series).toEqual([{ weekIndex: 0, weightKg: 80 }]);
    expect(result.naiveLineEndWeek).toBeCloseTo(0.22, 5);
    expect(result.currentWeightKg).toBe(80);
    expect(result.goalWeightKg).toBe(79.9);
  });

  test('edge case: imperial unit conversion + the below-floor threshold on both sides of it', () => {
    // heightCm = (5*12+8) * 2.54 = 68 * 2.54 = 172.72
    // currentWeightKg = 220.462 / 2.20462 = 100 exactly (220.462 = 100*2.20462)
    // goalWeightKg = 209.4389 / 2.20462 = 95 exactly (209.4389 = 95*2.20462)
    // bmr(100, 172.72, 25, female) = 10*100 + 6.25*172.72 - 5*25 - 161
    //                              = 1000 + 1079.5 - 125 - 161 = 1793.5
    // maintenance = 1793.5 * 1.2 (sedentary) = 2152.2 -> round 2152
    //
    // Case A, deficit=900: intake = 2152.2 - 900 = 1252.2 -> round 1252,
    //   comfortably above the female floor of 1200 -> proceeds normally.
    //   settle = (1252.2/1.2 - (6.25*172.72 - 125 - 161)) / 10
    //          = (1043.5 - 793.5) / 10 = 250 / 10 = 25
    //   reachable: 95 > 25 -> true
    const caseA = computeGoalDateProjection({
      sex: 'female',
      age: 25,
      units: 'imperial',
      heightFt: 5,
      heightIn: 8,
      currentWeight: 220.462,
      goalWeight: 209.4389,
      activityLevel: 'sedentary',
      dailyDeficitKcal: 900,
      referenceDate: '2026-01-01',
      includeChartSeries: false,
    });
    expect(caseA.currentWeightKg).toBe(100);
    expect(caseA.goalWeightKg).toBe(95);
    expect(caseA.maintenanceKcal).toBe(2152);
    expect(caseA.intakeKcal).toBe(1252);
    expect(caseA.floorKcal).toBe(1200);
    expect(caseA.status).not.toBe('belowFloor');
    expect(caseA.settleWeightKg).toBeCloseTo(25, 5);
    expect(caseA.reachedWithinHorizon).toBe(true);
    expect(Number.isInteger(caseA.daysToGoal)).toBe(true);
    expect(caseA.daysToGoal).toBeGreaterThan(0);
    expect(caseA.series).toBeNull();
    expect(caseA.naiveLineEndWeek).toBeNull();

    // Case B, deficit=1000: intake = 2152.2 - 1000 = 1152.2 -> round 1152,
    //   below the 1200 floor -> no projection at all.
    const caseB = computeGoalDateProjection({
      sex: 'female',
      age: 25,
      units: 'imperial',
      heightFt: 5,
      heightIn: 8,
      currentWeight: 220.462,
      goalWeight: 209.4389,
      activityLevel: 'sedentary',
      dailyDeficitKcal: 1000,
      referenceDate: '2026-01-01',
      includeChartSeries: false,
    });
    expect(caseB.status).toBe('belowFloor');
    expect(caseB.maintenanceKcal).toBe(2152);
    expect(caseB.intakeKcal).toBe(1152);
    expect(caseB.floorKcal).toBe(1200);
    expect(caseB.settleWeightKg).toBeNull();
    expect(caseB.reachedWithinHorizon).toBe(false);
    expect(caseB.projectedDate).toBeNull();
    expect(caseB.note).toContain('below the usual floor');
  });

  test('plateau: a goal at or below the settling weight is reported as a plateau, never a date', () => {
    // bmr(90, 175, 40, male) = 10*90 + 6.25*175 - 5*40 + 5 = 900+1093.75-200+5 = 1798.75
    // maintenance = 1798.75 * 1.2 (sedentary) ~= 2158.5
    // intake = maintenance - 250 ~= 1908.5 (>= 1500 floor)
    // settle = (intake/1.2 - (6.25*175 - 200 + 5)) / 10
    //        = (~1590.4167 - 898.75) / 10 ~= 69.1667
    // goal = 69, which is BELOW settle (~69.1667) -> not reachable -> plateau,
    // however long the (2-year) horizon runs.
    const result = computeGoalDateProjection({
      sex: 'male',
      age: 40,
      units: 'metric',
      heightCm: 175,
      currentWeight: 90,
      goalWeight: 69,
      activityLevel: 'sedentary',
      dailyDeficitKcal: 250,
      referenceDate: '2026-01-01',
      includeChartSeries: false,
    });

    expect(result.status).toBe('plateau');
    expect(result.plateau).toBe(true);
    expect(result.reachedWithinHorizon).toBe(false);
    expect(result.daysToGoal).toBeNull();
    expect(result.projectedDate).toBeNull();
    expect(result.horizonDays).toBe(730);
    expect(result.settleWeightKg).toBeCloseTo(69.2, 1);
    expect(result.note).toEqual(expect.stringContaining('settles near'));
    expect(result.note).toEqual(expect.stringContaining('69.2 kg'));
  });

  test('pure function throws for a schema-inexpressible bad combined height (0ft/0in), which register()\'s handler turns into toolResult.fail', () => {
    expect(() =>
      computeGoalDateProjection({
        sex: 'male',
        age: 30,
        units: 'imperial',
        heightFt: 0,
        heightIn: 0,
        currentWeight: 180,
        goalWeight: 160,
        activityLevel: 'moderate',
        dailyDeficitKcal: 500,
        referenceDate: '2026-01-01',
        includeChartSeries: false,
      })
    ).toThrow(/height/i);
  });

  test('mifflinStJeorBmr and addDaysIso helpers', () => {
    expect(mifflinStJeorBmr('male', 80, 180, 30)).toBe(1780);
    expect(mifflinStJeorBmr('female', 80, 180, 30)).toBe(1780 - 5 - 161); // same terms, minus the +5/-161 swing
    expect(addDaysIso('2026-01-31', 1)).toBe('2026-02-01'); // month rollover
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01'); // year rollover
  });

  test('cross-field validation: goalWeight must be below currentWeight, and height fields are required per units', () => {
    const schema = getRegisteredSchema();

    const goalNotBelowCurrent = schema.safeParse({
      sex: 'male',
      age: 30,
      units: 'metric',
      heightCm: 180,
      currentWeight: 80,
      goalWeight: 80, // equal, not less than -- must be rejected
      activityLevel: 'moderate',
      dailyDeficitKcal: 500,
    });
    expect(goalNotBelowCurrent.success).toBe(false);

    const missingImperialHeight = schema.safeParse({
      sex: 'male',
      age: 30,
      units: 'imperial',
      // heightFt / heightIn omitted -- required only because units is imperial
      currentWeight: 180,
      goalWeight: 160,
      activityLevel: 'moderate',
      dailyDeficitKcal: 500,
    });
    expect(missingImperialHeight.success).toBe(false);

    const validImperial = schema.safeParse({
      sex: 'male',
      age: 30,
      units: 'imperial',
      heightFt: 5,
      heightIn: 10,
      currentWeight: 180,
      goalWeight: 160,
      activityLevel: 'moderate',
      dailyDeficitKcal: 500,
    });
    expect(validImperial.success).toBe(true);

    // Same shape, but units defaults to metric -- so heightCm (not supplied
    // here) is the one that should now be flagged as missing.
    const missingMetricHeight = schema.safeParse({
      sex: 'male',
      age: 30,
      heightFt: 5,
      heightIn: 10,
      currentWeight: 180,
      goalWeight: 160,
      activityLevel: 'moderate',
      dailyDeficitKcal: 500,
    });
    expect(missingMetricHeight.success).toBe(false);

    // age below 18 is rejected by the plain z.number().min(18) bound.
    const tooYoung = schema.safeParse({
      sex: 'male',
      age: 17,
      units: 'metric',
      heightCm: 180,
      currentWeight: 80,
      goalWeight: 70,
      activityLevel: 'moderate',
      dailyDeficitKcal: 500,
    });
    expect(tooYoung.success).toBe(false);
  });
});
