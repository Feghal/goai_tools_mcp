'use strict';

const privacyLabel = require('../controllers/tools/privacy-label');

// Minimal stand-in for McpServer, matching the pattern used by
// __tests__/appstore.test.js: register() only needs a registerTool(name, def,
// handler) method, and these tests just capture what it was called with.
function makeFakeServer() {
  const tools = {};
  return {
    registerTool(name, def, handler) {
      tools[name] = { def, handler };
    },
    tools,
  };
}

describe('buildAppPrivacyLabel (pure logic, no MCP server)', () => {
  test('typical case: an analytics SDK plus an ad network', () => {
    // firebaseAnalytics.types = [deviceId, userId, productInteraction,
    //   otherUsage, crashData, performanceData]                       (6)
    // admob.types            = [deviceId, advertisingData,
    //   productInteraction, coarseLocation]                           (4, tracking: true)
    // Union (dedup deviceId + productInteraction shared by both):
    //   deviceId, userId, productInteraction, otherUsage, crashData,
    //   performanceData, advertisingData, coarseLocation  -> 8 distinct types.
    const result = privacyLabel.buildAppPrivacyLabel(['firebaseAnalytics', 'admob']);

    expect(result.sdkCount).toBe(2);
    expect(result.dataTypeCount).toBe(8);
    expect(result.trackingRequired).toBe(true); // admob.tracking === true
    expect(result.trackingNote).toBe(privacyLabel.STRINGS.trackingYes);
    expect(result.vendorDocumentationAsOf).toBe('2026-09-01');
    expect(result.disclaimer).toBe(privacyLabel.STRINGS.disclaimer);

    // Apple-grouping order (from GROUPS' own key order) restricted to groups
    // that actually have a present type: location, identifiers, usage, diagnostics.
    expect(result.groups.map((g) => g.id)).toEqual(['location', 'identifiers', 'usage', 'diagnostics']);

    // deviceId is caused by both chosen items, in the order they were given.
    const identifiers = result.groups.find((g) => g.id === 'identifiers');
    const deviceIdEntry = identifiers.dataTypes.find((d) => d.id === 'deviceId');
    expect(deviceIdEntry.causedBy).toEqual([
      'Analytics (Firebase, Google Analytics)',
      'Ad network (AdMob and similar)',
    ]);

    // The one-shot copy-checklist text embeds the same reasoning.
    expect(result.checklistText).toContain('Identifiers:');
    expect(result.checklistText).toContain(
      '  - Device ID — because of Analytics (Firebase, Google Analytics), Ad network (AdMob and similar)'
    );
    expect(result.checklistText).toContain('Used for tracking: yes');
  });

  test('edge case: repeated ids dedupe, and a non-tracking-only pick reports tracking: no', () => {
    // push.types = [deviceId, userId, productInteraction] (3), tracking: false.
    // Passing the same id twice must count it once, matching the source's
    // click-to-toggle `chosen` object (an id is either chosen or not -- there
    // is no "chosen twice" state).
    const result = privacyLabel.buildAppPrivacyLabel(['push', 'push']);

    expect(result.sdkCount).toBe(1);
    expect(result.dataTypeCount).toBe(3);
    expect(result.trackingRequired).toBe(false);
    expect(result.trackingNote).toBe(privacyLabel.STRINGS.trackingNo);

    // identifiers: [userId, deviceId] both present; usage: only
    // productInteraction present (advertisingData/otherUsage are not caused
    // by push) -- so exactly 2 groups, not 3+.
    expect(result.groups.map((g) => g.id)).toEqual(['identifiers', 'usage']);
    const usage = result.groups.find((g) => g.id === 'usage');
    expect(usage.dataTypes.map((d) => d.id)).toEqual(['productInteraction']);

    expect(result.checklistText).toContain('Used for tracking: no');
  });

  test('boundary: every SDK/feature chosen at once covers all 10 Apple groups', () => {
    // Hand-tallied distinct data types across all 18 entries' `types` arrays
    // (deviceId, userId, productInteraction, otherUsage, crashData,
    // performanceData, otherDiagnostic, advertisingData, coarseLocation,
    // email, name, purchaseHistory, customerSupport, photosVideos,
    // preciseLocation, health, fitness, contacts, searchHistory) = 19.
    const result = privacyLabel.buildAppPrivacyLabel(privacyLabel.SDK_IDS);

    expect(result.sdkCount).toBe(18);
    expect(result.dataTypeCount).toBe(19);
    expect(result.trackingRequired).toBe(true); // admob/metaSdk/attribution all tracking: true
    expect(result.groups).toHaveLength(10);
    expect(result.groups.map((g) => g.id)).toEqual(Object.keys(privacyLabel.GROUPS));

    // Every group's declared data types sum to the overall distinct count.
    const totalAcrossGroups = result.groups.reduce((sum, g) => sum + g.dataTypes.length, 0);
    expect(totalAcrossGroups).toBe(19);
  });

  test('typeLabel keeps the SDK-answer and data-type strings for "preciseLocation" distinct in source, identical in value', () => {
    // Both currently render "Precise location", but come from two different
    // string keys (preciseLocation vs preciseLocationType) -- see the source's
    // own comment on this. Exercise the data-type path specifically.
    expect(privacyLabel.typeLabel('preciseLocation')).toBe(privacyLabel.STRINGS.preciseLocationType);
    expect(privacyLabel.label('preciseLocation')).toBe(privacyLabel.STRINGS.preciseLocation);
  });
});

describe('build_app_privacy_label tool registration', () => {
  test('registers exactly one tool and its handler returns structured, non-error content', async () => {
    const server = makeFakeServer();
    privacyLabel.register(server);

    expect(Object.keys(server.tools)).toEqual(['build_app_privacy_label']);
    expect(privacyLabel.toolCount).toBe(1);

    const res = await server.tools.build_app_privacy_label.handler({ items: ['admob'] });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent.trackingRequired).toBe(true);
    expect(res.structuredContent.sdkCount).toBe(1);
  });
});
