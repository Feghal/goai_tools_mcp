'use strict';

const { estimateWindowLight, solarAspectOf } = require('../controllers/tools/window-light');

describe('solarAspectOf', () => {
  test('northern hemisphere: aspect passes through unchanged', () => {
    expect(solarAspectOf('S', 'north')).toBe('S');
    expect(solarAspectOf('NW', 'north')).toBe('NW');
  });

  test('southern hemisphere: N and S swap (in compound aspects too), E/W untouched', () => {
    expect(solarAspectOf('N', 'south')).toBe('S');
    expect(solarAspectOf('S', 'south')).toBe('N');
    expect(solarAspectOf('NE', 'south')).toBe('SE');
    expect(solarAspectOf('SW', 'south')).toBe('NW');
    expect(solarAspectOf('E', 'south')).toBe('E');
    expect(solarAspectOf('W', 'south')).toBe('W');
  });
});

describe('estimateWindowLight', () => {
  test('typical case: north hemisphere, south-facing, clear, on the sill -> Direct', () => {
    // score = SUN.S(4) * BLOCK.clear(1) * DIST.sill(1) = 4
    // 4 >= 3 (the 'Direct' threshold) so band = 'Direct'
    const result = estimateWindowLight({
      hemisphere: 'north',
      aspect: 'S',
      blocked: 'clear',
      distance: 'sill',
    });

    expect(result.score).toBeCloseTo(4, 5);
    expect(result.band).toBe('Direct');
    expect(result.solarAspect).toBe('S');
    expect(result.verdict).toBe('Direct sun');
    expect(result.verdictSub).toBe('Hours of sun landing on the leaves.');
    expect(result.reasoning).toBe(
      'This is the bright side of the building: sun for much of the day, and the strongest light any window here will give. ' +
        'Nothing is cutting it down. ' +
        'On the sill the plant gets the full view of the sky.'
    );
    expect(result.plants).toBe('Suits: succulents and cacti, jade, aloe, ponytail palm, string of pearls.');
  });

  test('edge case: worst combination (north-facing, heavily blocked, deep in the room) falls through to the "too dark" floor band', () => {
    // score = SUN.N(1.5) * BLOCK.heavy(0.22) * DIST.d4(0.09) = 1.5*0.22*0.09 = 0.0297
    // 0.0297 clears none of the 3 / 1.6 / 0.7 / 0.25 thresholds, only the
    // catch-all 0 -> band = 'None' ("Too dark for most plants").
    const result = estimateWindowLight({
      hemisphere: 'north',
      aspect: 'N',
      blocked: 'heavy',
      distance: 'd4',
    });

    expect(result.score).toBeCloseTo(0.0297, 4);
    expect(result.band).toBe('None');
    expect(result.solarAspect).toBe('N');
    expect(result.verdict).toBe('Too dark for most plants');
    expect(result.verdictSub).toBe('Below what a leaf can live on for long.');
    expect(result.reasoning).toBe(
      'No direct sun at all. Even, shadowless light, which is easy on leaves but never strong. ' +
        'Most of it is blocked before it reaches the glass. ' +
        'That far in, the window is a small bright rectangle and most of the light in the room is bounced off the walls.'
    );
    expect(result.plants).toBe(
      'Nothing will thrive here. A ZZ plant or snake plant will hold on, or add a grow light.'
    );
  });

  test('hemisphere flip: a north-facing window in the southern hemisphere is scored as the bright ("S") aspect', () => {
    // aspect 'N' + hemisphere 'south' -> solarAspect 'S' -> identical score
    // and verdict to the northern-hemisphere south-facing typical case above,
    // even though the input aspect is the opposite compass letter.
    const result = estimateWindowLight({
      hemisphere: 'south',
      aspect: 'N',
      blocked: 'clear',
      distance: 'sill',
    });

    expect(result.aspect).toBe('N');
    expect(result.solarAspect).toBe('S');
    expect(result.score).toBeCloseTo(4, 5);
    expect(result.band).toBe('Direct');
    expect(result.verdict).toBe('Direct sun');
  });

  test('west-facing, clear glass, on the sill adds the scorch warning regardless of band', () => {
    // score = SUN.W(2.8) * BLOCK.clear(1) * DIST.sill(1) = 2.8 -> band 'Bright'
    // (below the 3.0 'Direct' cutoff), but the scorch note is keyed off the
    // aspect/blocked/distance combination directly, not off the band.
    const result = estimateWindowLight({
      hemisphere: 'north',
      aspect: 'W',
      blocked: 'clear',
      distance: 'sill',
    });

    expect(result.score).toBeCloseTo(2.8, 5);
    expect(result.band).toBe('Bright');
    expect(result.reasoning.endsWith(
      'Watch the afternoon in summer: direct west sun through glass will scorch leaves that would be fine outdoors.'
    )).toBe(true);
  });
});
