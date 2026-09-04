'use strict';

const {
  computeWateringCalendar,
  intervalDaysFor,
  seasonForDate,
  isoDate,
  PLANT_IDS,
  inputSchema,
} = require('../controllers/tools/plant-watering');

// Fixed instant used everywhere below so DTSTAMP (which is derived from UTC
// clock fields) is deterministic regardless of the machine/CI timezone.
const NOW = new Date(Date.UTC(2026, 5, 15, 12, 0, 0)); // 2026-06-15T12:00:00Z

describe('plant_watering_calendar', () => {
  test('catalog has the source page\'s 32 plant ids', () => {
    expect(PLANT_IDS.length).toBe(32);
    expect(PLANT_IDS).toEqual(
      expect.arrayContaining(['snake', 'monstera', 'cactus', 'fittonia', 'africanViolet'])
    );
  });

  test('typical case: monstera + cactus in summer, defaults for pot/light, computed by hand', () => {
    // multiplier = potSize(medium=1) * potMaterial(plastic=1) * light(indirect=1) * season(summer=0.8) = 0.8
    // monstera: baseDays 9  -> round(9  * 0.8) = round(7.2)  = 7  -> max(2,7)  = 7
    // cactus:   baseDays 24 -> round(24 * 0.8) = round(19.2) = 19 -> max(2,19) = 19
    // table is sorted by intervalDays ascending -> [monstera(7), cactus(19)]
    const result = computeWateringCalendar(
      { plants: ['monstera', 'cactus'], season: 'summer', startDate: '2026-06-15' },
      NOW
    );

    expect(result.schedule).toEqual([
      { key: 'monstera', name: 'Monstera', intervalDays: 7, baseDays: 9, multiplier: 0.8 },
      { key: 'cactus', name: 'Cactus', intervalDays: 19, baseDays: 24, multiplier: 0.8 },
    ]);
    expect(result.summary).toEqual({
      chosenCount: 2,
      minIntervalDays: 7,
      maxIntervalDays: 19,
      seasonFactor: 0.8,
    });

    expect(result.calendar.filename).toBe('plant-watering.ics');
    expect(result.calendar.mimeType).toBe('text/calendar;charset=utf-8');

    // ICS event order/UID index follows the *original* selection order
    // (source: Object.keys(chosen) insertion order in ics()), which here
    // happens to match the input array order -- monstera first, cactus
    // second -- not the interval-sorted `schedule` order above.
    const ics = result.calendar.icsText;
    expect(ics).toContain('BEGIN:VCALENDAR\r\n');
    expect(ics).toContain('PRODID:-//GO AI//Plant watering calendar//EN\r\n');
    expect(ics).toContain('UID:20260615-0-monstera@goai.tools\r\n');
    expect(ics).toContain('DTSTAMP:20260615T120000Z\r\n');
    expect(ics).toContain('DTSTART;VALUE=DATE:20260615\r\n');
    expect(ics).toContain('RRULE:FREQ=DAILY;INTERVAL=7\r\n');
    expect(ics).toContain('SUMMARY:Check Monstera\r\n');
    expect(ics).toContain('UID:20260615-1-cactus@goai.tools\r\n');
    expect(ics).toContain('RRULE:FREQ=DAILY;INTERVAL=19\r\n');
    expect(ics).toContain('SUMMARY:Check Cactus\r\n');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);

    // The DESCRIPTION line for the 7-day interval crosses the RFC 5545
    // 75-octet fold boundary (all ASCII here, so octets == chars):
    // "DESCRIPTION:Put a finger in the soil. Water only if the top few centimetres"
    // is exactly 75 characters, so folding cuts right there. The remainder
    // (" are dry...") already starts with the content's own word-space, and
    // RFC 5545 folding adds one more leading space as the continuation
    // marker -- so the folded line legitimately starts with two spaces;
    // unfolding removes only the single marker space, restoring the
    // original single space between "centimetres" and "are".
    expect(ics).toContain(
      'DESCRIPTION:Put a finger in the soil. Water only if the top few centimetres\r\n' +
        '  are dry. Interval: every 7 days.\r\n'
    );
  });

  test('minimum-interval floor: an aggressive drying combo still clamps to 2 days, never below', () => {
    // multiplier = potSize(small=0.7) * potMaterial(terracotta=0.75) * light(bright=0.8) * season(summer=0.8)
    //            = 0.7 * 0.75 * 0.8 * 0.8 = 0.336
    // fittonia baseDays 3 -> round(3 * 0.336) = round(1.008) = 1 -> max(2,1) = 2 (the documented floor)
    const result = computeWateringCalendar(
      {
        plants: ['fittonia'],
        potSize: 'small',
        potMaterial: 'terracotta',
        light: 'bright',
        season: 'summer',
      },
      NOW
    );

    expect(intervalDaysFor(3, 0.336)).toBe(2);
    expect(result.schedule[0]).toEqual({
      key: 'fittonia',
      name: 'Nerve plant',
      intervalDays: 2,
      baseDays: 3,
      // round2(0.336) = round(33.6)/100 = 34/100 = 0.34
      multiplier: 0.34,
    });
    expect(result.summary.minIntervalDays).toBe(2);
    expect(result.summary.maxIntervalDays).toBe(2);
  });

  test('season default follows the source\'s northern-hemisphere month table when season is omitted', () => {
    // seasonForDate mirrors the source's inline array indexed by getMonth():
    // Jan/Feb/Dec -> winter, Mar-May -> spring, Jun-Aug -> summer, Sep-Nov -> autumn.
    expect(seasonForDate(new Date(2026, 0, 1))).toBe('winter'); // January
    expect(seasonForDate(new Date(2026, 5, 1))).toBe('summer'); // June
    expect(seasonForDate(new Date(2026, 8, 1))).toBe('autumn'); // September

    const juneNow = new Date(2026, 5, 15, 9, 0, 0); // a local June date/time
    const result = computeWateringCalendar({ plants: ['cactus'] }, juneNow);
    // multiplier = 1 * 1 * 1 * summer(0.8) = 0.8 -> round(24 * 0.8) = round(19.2) = 19
    expect(result.schedule[0].intervalDays).toBe(19);
    expect(result.summary.seasonFactor).toBe(0.8);
    // startDate also defaults from the same injected "now", via isoDate() --
    // local Y-M-D, matching the source's iso().
    expect(result.calendar.icsText).toContain(`DTSTART;VALUE=DATE:${isoDate(juneNow).replace(/-/g, '')}`);
  });

  test('an out-of-range calendar date (schema regex cannot catch it) fails cleanly instead of throwing an MCP-level error', () => {
    // "2026-02-30" matches the YYYY-MM-DD *shape* the schema regex checks,
    // so this is exactly the "schema couldn't express it" case the pure
    // function itself has to reject -- via a thrown Error the tool handler
    // turns into toolResult.fail(), never a raw exception.
    expect(() => computeWateringCalendar({ plants: ['fern'], startDate: '2026-02-30' }, NOW)).toThrow(
      /not a real calendar date/
    );
  });

  test('schema validation: at least one plant is required, and an unknown plant id is rejected', () => {
    const noPlants = inputSchema.safeParse({ plants: [] });
    expect(noPlants.success).toBe(false);
    expect(noPlants.error.issues[0].message).toBe('Choose at least one plant.');

    const unknownId = inputSchema.safeParse({ plants: ['definitely-not-a-plant'] });
    expect(unknownId.success).toBe(false);
    expect(unknownId.error.issues[0].path).toEqual(['plants', 0]);

    const ok = inputSchema.safeParse({ plants: ['monstera', 'monstera'] });
    expect(ok.success).toBe(true);
    // Duplicates pass schema validation (it's just an array of enums); the
    // pure function is what dedupes them -- covered by computeWateringCalendar.
    expect(ok.data.plants).toEqual(['monstera', 'monstera']);
  });

  test('duplicate plant ids in the input are deduped exactly once, keeping first occurrence', () => {
    const result = computeWateringCalendar({ plants: ['pothos', 'pothos', 'fern'], season: 'spring' }, NOW);
    expect(result.summary.chosenCount).toBe(2);
    expect(result.schedule.map((row) => row.key).sort()).toEqual(['fern', 'pothos']);
  });
});
