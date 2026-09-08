'use strict';

const { z } = require('zod');
const toolResult = require('../../utils/toolResult');
const toolAnnotations = require('../../utils/toolAnnotations');

// Port of nginx/sites/goai/tools/privacy-label.html ("App privacy label
// builder"). The source ships its decision table and copy as two
// <script type="application/json"> blocks (#privacy-table, #privacy-strings)
// and an inline <script> that reads them, keyed on which SDK/feature buttons
// the visitor has toggled -- everything below is a straight port of that
// data plus the render()/copy-checklist logic, since this module has no DOM
// to load the JSON blocks from.

// Verbatim copy of the #privacy-table JSON's "sdks" array. Order matches the
// source (its button list) exactly, which is also the order the "identical
// dates -> single joined string" note below relies on being reproducible.
const SDKS = [
  { id: 'firebaseAnalytics', tracking: false, checked: '2026-09-01',
    types: ['deviceId', 'userId', 'productInteraction', 'otherUsage', 'crashData', 'performanceData'] },
  { id: 'crashlytics', tracking: false, checked: '2026-09-01',
    types: ['crashData', 'performanceData', 'otherDiagnostic', 'deviceId'] },
  { id: 'sentry', tracking: false, checked: '2026-09-01',
    types: ['crashData', 'performanceData', 'otherDiagnostic', 'deviceId'] },
  { id: 'amplitude', tracking: false, checked: '2026-09-01',
    types: ['deviceId', 'userId', 'productInteraction', 'otherUsage'] },
  { id: 'admob', tracking: true, checked: '2026-09-01',
    types: ['deviceId', 'advertisingData', 'productInteraction', 'coarseLocation'] },
  { id: 'metaSdk', tracking: true, checked: '2026-09-01',
    types: ['deviceId', 'userId', 'advertisingData', 'productInteraction'] },
  { id: 'attribution', tracking: true, checked: '2026-09-01',
    types: ['deviceId', 'advertisingData', 'productInteraction'] },
  { id: 'push', tracking: false, checked: '2026-09-01',
    types: ['deviceId', 'userId', 'productInteraction'] },
  { id: 'accounts', tracking: false, checked: '2026-09-01',
    types: ['email', 'name', 'userId'] },
  { id: 'signInApple', tracking: false, checked: '2026-09-01',
    types: ['email', 'name', 'userId'] },
  { id: 'iap', tracking: false, checked: '2026-09-01',
    types: ['purchaseHistory', 'userId'] },
  { id: 'revenuecat', tracking: false, checked: '2026-09-01',
    types: ['purchaseHistory', 'userId', 'deviceId'] },
  { id: 'support', tracking: false, checked: '2026-09-01',
    types: ['email', 'name', 'customerSupport', 'deviceId'] },
  { id: 'userPhotos', tracking: false, checked: '2026-09-01',
    types: ['photosVideos'] },
  { id: 'preciseLocation', tracking: false, checked: '2026-09-01',
    types: ['preciseLocation'] },
  { id: 'healthKit', tracking: false, checked: '2026-09-01',
    types: ['health', 'fitness'] },
  { id: 'contactsAccess', tracking: false, checked: '2026-09-01',
    types: ['contacts'] },
  { id: 'search', tracking: false, checked: '2026-09-01',
    types: ['searchHistory', 'productInteraction'] },
];
const SDKS_BY_ID = new Map(SDKS.map((s) => [s.id, s]));
const SDK_IDS = SDKS.map((s) => s.id);

// Verbatim copy of the #privacy-table JSON's "groups" object. Key order is
// Apple's own grouping order and is iterated in that order below (matching
// the source's `Object.keys(T.groups).forEach(...)`), so both the on-page
// sections and this tool's `groups` array come out in the same sequence.
const GROUPS = {
  contact: ['email', 'name', 'phone'],
  health: ['health', 'fitness'],
  financial: ['purchaseHistory'],
  location: ['preciseLocation', 'coarseLocation'],
  contactsGroup: ['contacts'],
  content: ['photosVideos', 'customerSupport'],
  history: ['searchHistory'],
  identifiers: ['userId', 'deviceId'],
  usage: ['productInteraction', 'advertisingData', 'otherUsage'],
  diagnostics: ['crashData', 'performanceData', 'otherDiagnostic'],
};

// Verbatim copy of the #privacy-strings JSON. Doubles as both UI copy and,
// via label()/typeLabel() below, the display name for every SDK, group and
// data-type id -- exactly as the source's S object does.
const STRINGS = {
  disclaimer:
    "This is a starting checklist, not compliance advice and not an answer you can submit. SDKs change what they collect, your configuration changes it again, and you are the one who signs the declaration. Verify every line against the SDK's current documentation and your own build before you fill in App Store Connect.",
  kTracking: 'Used for tracking',
  trackingYes:
    'At least one of these turns on tracking, so you will also need App Tracking Transparency and the tracking declaration. That is the answer worth double-checking.',
  trackingNo: 'Nothing chosen here normally requires tracking to be declared. Confirm it anyway if you monetise with ads.',
  becauseFmt: 'because of {list}',
  checkedFmt: 'vendor documentation as of {date}',
  yes: 'yes',
  no: 'no',
  firebaseAnalytics: 'Analytics (Firebase, Google Analytics)',
  crashlytics: 'Crash reporting (Crashlytics)',
  sentry: 'Error monitoring (Sentry)',
  amplitude: 'Product analytics (Amplitude, Mixpanel)',
  admob: 'Ad network (AdMob and similar)',
  metaSdk: 'Meta SDK, login or ads',
  attribution: 'Attribution (AppsFlyer, Adjust, Branch)',
  push: 'Push notifications (OneSignal, Firebase Messaging)',
  accounts: 'Accounts with email sign-up',
  signInApple: 'Sign in with Apple',
  iap: 'In-app purchases or subscriptions',
  revenuecat: 'Subscription platform (RevenueCat)',
  support: 'In-app support or feedback',
  userPhotos: 'Users upload photos or video',
  preciseLocation: 'Precise location',
  healthKit: 'Health or fitness data',
  contactsAccess: 'Access to the address book',
  search: 'In-app search',
  contact: 'Contact info',
  health: 'Health and fitness',
  financial: 'Financial info',
  location: 'Location',
  contactsGroup: 'Contacts',
  content: 'User content',
  history: 'Search history',
  identifiers: 'Identifiers',
  usage: 'Usage data',
  diagnostics: 'Diagnostics',
  email: 'Email address',
  name: 'Name',
  phone: 'Phone number',
  purchaseHistory: 'Purchase history',
  preciseLocationType: 'Precise location',
  coarseLocation: 'Coarse location',
  contacts: 'Contacts',
  photosVideos: 'Photos or videos',
  customerSupport: 'Customer support',
  searchHistory: 'Search history',
  userId: 'User ID',
  deviceId: 'Device ID',
  productInteraction: 'Product interaction',
  advertisingData: 'Advertising data',
  otherUsage: 'Other usage data',
  crashData: 'Crash data',
  performanceData: 'Performance data',
  otherDiagnostic: 'Other diagnostic data',
};

// Exact port of the source's t(key, vars): "{name}" placeholder substitution.
function t(key, vars) {
  var s = STRINGS[key] || key;
  for (var k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}

// Exact port of the source's label(id): falls back to the raw id when it
// isn't a known string key (can't happen for our fixed table, but kept for
// fidelity -- see the source's own comment on preciseLocation being both an
// SDK answer and a data type).
function label(id) {
  return STRINGS[id] === undefined ? id : STRINGS[id];
}

// Exact port of the source's typeLabel(): 'preciseLocation' the data type
// reads from a separate string (preciseLocationType) than 'preciseLocation'
// the SDK/feature answer, even though both currently render "Precise
// location" -- kept distinct here for the same reason the source keeps them
// distinct (a future wording change to one must not silently affect the other).
function typeLabel(type) {
  return type === 'preciseLocation' ? STRINGS.preciseLocationType : label(type);
}

// Pure port of the source's render(): given the set of chosen SDK/feature
// ids, works out which data types they cause, whether tracking applies, and
// builds both the structured group breakdown and the plain-text checklist
// the page's "Copy the checklist" button places on the clipboard.
function buildAppPrivacyLabel(itemIds) {
  // Dedupe while preserving first-occurrence order, mirroring the source's
  // `chosen` object (an id toggled twice cancels out to "not chosen" in the
  // browser's click handler; here, repeating an id in the input list simply
  // counts it once).
  const seen = new Set();
  const ids = [];
  for (const raw of itemIds) {
    if (!seen.has(raw)) {
      seen.add(raw);
      ids.push(raw);
    }
  }
  const chosenSdks = ids.map((id) => SDKS_BY_ID.get(id)).filter(Boolean);

  // type id -> ordered list of the chosen items' display labels that cause it.
  const causes = new Map();
  let tracking = false;
  const dates = new Set();
  chosenSdks.forEach((sdk) => {
    if (sdk.tracking) tracking = true;
    dates.add(sdk.checked);
    sdk.types.forEach((ty) => {
      if (!causes.has(ty)) causes.set(ty, []);
      causes.get(ty).push(label(sdk.id));
    });
  });

  const vendorDocumentationAsOf = Array.from(dates).sort().join(', ');
  const trackingNote = tracking ? STRINGS.trackingYes : STRINGS.trackingNo;

  const groups = [];
  const lines = [];
  Object.keys(GROUPS).forEach((groupId) => {
    const present = GROUPS[groupId].filter((ty) => causes.has(ty));
    if (!present.length) return;
    lines.push(label(groupId) + ':');
    const dataTypes = present.map((ty) => {
      const causedBy = causes.get(ty).slice();
      const because = t('becauseFmt', { list: causedBy.join(', ') });
      lines.push('  - ' + typeLabel(ty) + ' — ' + because);
      return { id: ty, label: typeLabel(ty), causedBy };
    });
    groups.push({ id: groupId, label: label(groupId), dataTypes });
  });

  lines.push('');
  lines.push(STRINGS.kTracking + ': ' + (tracking ? STRINGS.yes : STRINGS.no));
  lines.push(t('checkedFmt', { date: vendorDocumentationAsOf }));
  lines.push(STRINGS.disclaimer);

  return {
    trackingRequired: tracking,
    dataTypeCount: causes.size,
    sdkCount: chosenSdks.length,
    trackingNote,
    vendorDocumentationAsOf,
    disclaimer: STRINGS.disclaimer,
    groups,
    checklistText: lines.join('\n'),
  };
}

// The shape of the JSON in structuredContent. Declared so an agent can
// read the result without parsing prose -- and, because the SDK validates
// every success against it, so a handler that quietly stops returning a
// field fails here instead of downstream. Nullable fields below are the
// ones the computation genuinely leaves empty, not defensive padding.
const privacyLabelOutputSchema = {
  trackingRequired: z
    .boolean()
    .describe('True when at least one chosen item implies App Tracking Transparency / the "Used to Track You" declaration.'),
  dataTypeCount: z.number().int().describe('Total number of distinct data types to declare across all groups.'),
  sdkCount: z.number().int().describe('How many distinct SDKs/features were considered, after repeats collapse.'),
  trackingNote: z.string().describe('Explanation of the tracking verdict and what it obliges.'),
  vendorDocumentationAsOf: z
    .string()
    .describe('The date this mapping table was last checked against vendor documentation -- SDKs change what they collect, so this bounds how much to trust the answer.'),
  disclaimer: z.string().describe('Standing note that this is a deterministic lookup, not a code scan and not compliance advice.'),
  groups: z
    .array(
      z.object({
        id: z.string().describe('Stable identifier for the App Store Connect group.'),
        label: z.string().describe("The group name as Apple presents it, e.g. 'Identifiers', 'Usage Data'."),
        dataTypes: z
          .array(
            z.object({
              id: z.string().describe('Stable identifier for the data type.'),
              label: z.string().describe('The data type as Apple names it.'),
              causedBy: z.array(z.string()).describe('Which of the chosen items pulled this data type in -- the audit trail for the entry.'),
            })
          )
          .describe('The data types to declare under this group.'),
      })
    )
    .describe('Data types to declare, grouped the way App Store Connect groups them.'),
  checklistText: z.string().describe('The whole result as pasteable plain text, for dropping into a ticket or a submission checklist.'),
};

function register(server) {
  server.registerTool(
    'build_app_privacy_label',
    {
      title: 'Build an App Store privacy label checklist',
      description:
        "Given which SDKs and features are present in an iOS app (analytics, crash reporting, ads, attribution, accounts, in-app purchases, location, HealthKit, contacts, search, etc.), returns the App Store Connect privacy data types those items most likely require declaring, grouped the way Apple groups them (Contact info, Identifiers, Usage data, Diagnostics, ...), each with the reason (which chosen item(s) caused it), plus whether App Tracking Transparency/tracking applies and the vendor-documentation date the mapping was checked against. This is a fixed, deterministic lookup table shipped with GO AI's privacy-label-builder page -- not a code scanner and not compliance advice. SDKs change what they collect (sometimes in a minor version) and app configuration changes it further, so treat the result as a starting checklist to verify against each SDK's current documentation, not an answer to submit as-is.",
      annotations: toolAnnotations.PURE,
      outputSchema: privacyLabelOutputSchema,
      inputSchema: {
        items: z
          .array(z.enum(SDK_IDS))
          .min(1, 'items must include at least one SDK/feature id')
          // The enum bounds each entry's VALUE but not the array's LENGTH,
          // and the dedupe loop runs once per entry before repeats collapse.
          // There are only SDK_IDS.length distinct ids, so the catalog size is
          // the natural cap.
          .max(SDK_IDS.length, `At most ${SDK_IDS.length} items (the whole list); repeats are ignored.`)
          .describe(
            'SDKs/features present in the app binary. One or more of: ' + SDK_IDS.join(', ') + '. Repeats are ignored.'
          ),
      },
    },
    async (args) => {
      try {
        const result = buildAppPrivacyLabel(args.items);
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
  buildAppPrivacyLabel,
  SDKS,
  GROUPS,
  STRINGS,
  SDK_IDS,
  label,
  typeLabel,
};
