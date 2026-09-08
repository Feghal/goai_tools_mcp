'use strict';

const { z } = require('zod');
const toolResult = require('../../utils/toolResult');
const toolAnnotations = require('../../utils/toolAnnotations');
const { withThrottle } = require('../../utils/itunesThrottle');

// Port of nginx/sites/goai/tools/appstore.html ("App Store storefront
// checker"). That page runs entirely client-side against Apple's public,
// CORS-enabled iTunes Search/Lookup API -- these two tools reproduce its two
// modes (search one storefront / compare one app across markets) with the
// same request shape and the same field mapping from Apple's response.
//
// Deviation from the source noted where it applies: the page's hero copy
// says "~175" country storefronts while assets/storefronts.js (the actual
// list both this page and the app-store-link tool draw from,
// window.GOAI_STOREFRONTS) enumerates 173 -- app-store-link.html's own meta
// description says "173" too, so 173 is treated as ground truth here; the
// full list is reproduced below since this module cannot load a browser
// <script> file.

// Every App Store storefront the source's shared assets/storefronts.js
// lists (window.GOAI_STOREFRONTS), copied here since that file is a browser
// global, not a requirable module. A code that isn't a live storefront just
// returns zero results from Apple -- the source's own comment on this list
// -- so this is used for normalizing/labelling input, not for rejecting an
// unrecognized-but-well-formed code.
const STOREFRONTS = [
  ['AE', 'United Arab Emirates'], ['AF', 'Afghanistan'], ['AG', 'Antigua & Barbuda'], ['AI', 'Anguilla'],
  ['AL', 'Albania'], ['AM', 'Armenia'], ['AO', 'Angola'], ['AR', 'Argentina'],
  ['AT', 'Austria'], ['AU', 'Australia'], ['AZ', 'Azerbaijan'], ['BA', 'Bosnia & Herzegovina'],
  ['BB', 'Barbados'], ['BE', 'Belgium'], ['BF', 'Burkina Faso'], ['BG', 'Bulgaria'],
  ['BH', 'Bahrain'], ['BJ', 'Benin'], ['BM', 'Bermuda'], ['BN', 'Brunei'],
  ['BO', 'Bolivia'], ['BR', 'Brazil'], ['BS', 'Bahamas'], ['BT', 'Bhutan'],
  ['BW', 'Botswana'], ['BY', 'Belarus'], ['BZ', 'Belize'], ['CA', 'Canada'],
  ['CD', 'Congo (DRC)'], ['CG', 'Congo'], ['CH', 'Switzerland'], ['CI', "Côte d'Ivoire"],
  ['CL', 'Chile'], ['CM', 'Cameroon'], ['CN', 'China mainland'], ['CO', 'Colombia'],
  ['CR', 'Costa Rica'], ['CV', 'Cape Verde'], ['CY', 'Cyprus'], ['CZ', 'Czechia'],
  ['DE', 'Germany'], ['DK', 'Denmark'], ['DM', 'Dominica'], ['DO', 'Dominican Republic'],
  ['DZ', 'Algeria'], ['EC', 'Ecuador'], ['EE', 'Estonia'], ['EG', 'Egypt'],
  ['ES', 'Spain'], ['FI', 'Finland'], ['FJ', 'Fiji'], ['FM', 'Micronesia'],
  ['FR', 'France'], ['GA', 'Gabon'], ['GB', 'United Kingdom'], ['GD', 'Grenada'],
  ['GH', 'Ghana'], ['GM', 'Gambia'], ['GR', 'Greece'], ['GT', 'Guatemala'],
  ['GW', 'Guinea-Bissau'], ['GY', 'Guyana'], ['HK', 'Hong Kong'], ['HN', 'Honduras'],
  ['HR', 'Croatia'], ['HU', 'Hungary'], ['ID', 'Indonesia'], ['IE', 'Ireland'],
  ['IL', 'Israel'], ['IN', 'India'], ['IQ', 'Iraq'], ['IS', 'Iceland'],
  ['IT', 'Italy'], ['JM', 'Jamaica'], ['JO', 'Jordan'], ['JP', 'Japan'],
  ['KE', 'Kenya'], ['KG', 'Kyrgyzstan'], ['KH', 'Cambodia'], ['KN', 'St. Kitts & Nevis'],
  ['KR', 'South Korea'], ['KW', 'Kuwait'], ['KY', 'Cayman Islands'], ['KZ', 'Kazakhstan'],
  ['LA', 'Laos'], ['LB', 'Lebanon'], ['LC', 'St. Lucia'], ['LK', 'Sri Lanka'],
  ['LR', 'Liberia'], ['LT', 'Lithuania'], ['LU', 'Luxembourg'], ['LV', 'Latvia'],
  ['LY', 'Libya'], ['MD', 'Moldova'], ['ME', 'Montenegro'], ['MG', 'Madagascar'],
  ['MK', 'North Macedonia'], ['ML', 'Mali'], ['MM', 'Myanmar'], ['MN', 'Mongolia'],
  ['MO', 'Macao'], ['MR', 'Mauritania'], ['MS', 'Montserrat'], ['MT', 'Malta'],
  ['MU', 'Mauritius'], ['MV', 'Maldives'], ['MW', 'Malawi'], ['MX', 'Mexico'],
  ['MY', 'Malaysia'], ['MZ', 'Mozambique'], ['NA', 'Namibia'], ['NE', 'Niger'],
  ['NG', 'Nigeria'], ['NI', 'Nicaragua'], ['NL', 'Netherlands'], ['NO', 'Norway'],
  ['NP', 'Nepal'], ['NR', 'Nauru'], ['NZ', 'New Zealand'], ['OM', 'Oman'],
  ['PA', 'Panama'], ['PE', 'Peru'], ['PG', 'Papua New Guinea'], ['PH', 'Philippines'],
  ['PK', 'Pakistan'], ['PL', 'Poland'], ['PT', 'Portugal'], ['PW', 'Palau'],
  ['PY', 'Paraguay'], ['QA', 'Qatar'], ['RO', 'Romania'], ['RS', 'Serbia'],
  ['RU', 'Russia'], ['RW', 'Rwanda'], ['SA', 'Saudi Arabia'], ['SB', 'Solomon Islands'],
  ['SC', 'Seychelles'], ['SE', 'Sweden'], ['SG', 'Singapore'], ['SI', 'Slovenia'],
  ['SK', 'Slovakia'], ['SL', 'Sierra Leone'], ['SN', 'Senegal'], ['SR', 'Suriname'],
  ['ST', 'São Tomé & Príncipe'], ['SV', 'El Salvador'], ['SZ', 'Eswatini'], ['TC', 'Turks & Caicos'],
  ['TD', 'Chad'], ['TH', 'Thailand'], ['TJ', 'Tajikistan'], ['TM', 'Turkmenistan'],
  ['TN', 'Tunisia'], ['TO', 'Tonga'], ['TR', 'Türkiye'], ['TT', 'Trinidad & Tobago'],
  ['TW', 'Taiwan'], ['TZ', 'Tanzania'], ['UA', 'Ukraine'], ['UG', 'Uganda'],
  ['US', 'United States'], ['UY', 'Uruguay'], ['UZ', 'Uzbekistan'], ['VC', 'St. Vincent & Grenadines'],
  ['VE', 'Venezuela'], ['VG', 'British Virgin Islands'], ['VN', 'Vietnam'], ['VU', 'Vanuatu'],
  ['XK', 'Kosovo'], ['YE', 'Yemen'], ['ZA', 'South Africa'], ['ZM', 'Zambia'],
  ['ZW', 'Zimbabwe'],
];
const STOREFRONT_NAMES = new Map(STOREFRONTS.map(([code, name]) => [code, name]));

// The source page's "30 major markets" quick-compare set (its MAJOR array) --
// used here as the default when appstore_compare_markets is called without
// an explicit storefront list.
const MAJOR_MARKETS = [
  'US', 'GB', 'DE', 'FR', 'ES', 'IT', 'NL', 'SE', 'PL', 'TR', 'RU', 'UA', 'AE', 'SA', 'IN',
  'ID', 'JP', 'KR', 'CN', 'TW', 'HK', 'SG', 'AU', 'CA', 'BR', 'MX', 'AR', 'ZA', 'NG', 'EG',
];

const MAX_STOREFRONTS_PER_CALL = 30;

// ---------------------------------------------------------------------------
// Outbound-load bounds (this server is PUBLIC and UNAUTHENTICATED)
// ---------------------------------------------------------------------------
// Every call here spends OUR IP's budget against Apple. itunesThrottle caps
// CONCURRENCY (4 at once) but explicitly not RATE -- its own header says so.
// So the per-call fan-out below is the only thing bounding how much load one
// stranger's request can direct at Apple.

// An App Store track id is 9-10 digits. extractAppId's /(?:id)?(\d{6,})/ has
// no upper bound, so a 3 MB run of digits was accepted as an "app id" and
// interpolated into the lookup URL -- verified: a 3 MB id, sent to Apple 30
// times in one call. 24 digits is generous headroom over any real id.
const MAX_APP_ID_DIGITS = 24;

// The search term goes straight into the query string of an outbound request.
// Apple's own search box is a phrase, not a document.
const MAX_SEARCH_TERM_CHARS = 200;

// The source's THROTTLE.quick delay (ms) applied between sequential lookups
// for its 30-market "major" scope -- see appstore.html. Its THROTTLE.all
// (3200ms, for sweeping all ~175/173 storefronts) is intentionally never
// used here: this tool caps a single call at MAX_STOREFRONTS_PER_CALL
// precisely so it never needs to.
const LOOKUP_DELAY_MS = 350;

const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const ITUNES_LOOKUP_URL = 'https://itunes.apple.com/lookup';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mirrors appstore.html's parseId(): an optional "id" prefix followed by 6+
// digits, taken from anywhere in the string -- so both a bare id
// ("6742322421") and a full apps.apple.com URL
// ("https://apps.apple.com/us/app/x/id6742322421") resolve the same way.
function extractAppId(raw) {
  const m = String(raw == null ? '' : raw).match(/(?:id)?(\d{6,})/);
  if (!m) return null;
  // A run of digits longer than any real track id is not an app id -- it is
  // an attempt to make this server send a huge URL to Apple, 30 times over.
  // Rejected rather than truncated: truncating would silently look up a
  // DIFFERENT app than the caller named.
  if (m[1].length > MAX_APP_ID_DIGITS) return null;
  return m[1];
}

// Normalizes a caller-supplied storefront list: trims, uppercases, drops
// anything that isn't 2 letters, and de-duplicates while preserving order.
// An empty/omitted list falls back to MAJOR_MARKETS, mirroring the source
// page's own default "30 major markets" scope.
function normalizeStorefronts(list) {
  if (list == null) return { storefronts: MAJOR_MARKETS.slice(), usedDefault: true };
  const arr = Array.isArray(list) ? list : [list];
  if (arr.length === 0) return { storefronts: MAJOR_MARKETS.slice(), usedDefault: true };

  const seen = new Set();
  const codes = [];
  const invalid = [];
  for (const raw of arr) {
    const code = String(raw == null ? '' : raw).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) {
      invalid.push(String(raw));
      continue;
    }
    if (!seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
  }
  return { storefronts: codes, usedDefault: false, invalid };
}

function storefrontLabel(code) {
  return STOREFRONT_NAMES.get(code) || code;
}

async function fetchJson(url) {
  return withThrottle(async () => {
    const res = await fetch(url);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  });
}

// One country's worth of the "Search a storefront" mode. Same query shape
// as the source's doSearch(): term + country + entity + limit=200, 200
// being the API's own per-request ceiling (not a choice this tool makes).
async function searchStorefront({ term, country, entity }) {
  const url = `${ITUNES_SEARCH_URL}?term=${encodeURIComponent(term)}&country=${encodeURIComponent(country)}&entity=${encodeURIComponent(entity)}&limit=200`;
  const data = await fetchJson(url);
  const resultCount = data.resultCount || 0;
  const apps = (data.results || []).map((a) => ({
    appId: a.trackId != null ? String(a.trackId) : null,
    title: a.trackName || null,
    seller: a.sellerName || null,
    price: a.formattedPrice || null,
    currency: a.currency || null,
    rating: typeof a.averageUserRating === 'number' ? a.averageUserRating : null,
    ratingCount: a.userRatingCount || 0,
    storeLink: a.trackViewUrl || null,
    artworkUrl: a.artworkUrl100 || null,
  }));
  return {
    term,
    country,
    entity,
    resultCount,
    // 200 is the Search API's own per-request maximum -- hitting it means
    // there are likely more matches than were returned, per the source's FAQ.
    capped: resultCount >= 200,
    apps,
  };
}

// The "Compare one app across markets" mode. Sequential lookups (not
// parallel) paced by LOOKUP_DELAY_MS between each, same as the source's
// doCompare() loop -- so a 30-storefront call takes a little over 10
// seconds, not an instant fan-out that would look like abuse to Apple.
async function compareAcrossMarkets({ appId, storefronts }) {
  const rows = [];
  let found = 0;
  let failed = 0;
  const titles = new Set();

  for (let i = 0; i < storefronts.length; i++) {
    const country = storefronts[i];
    try {
      const data = await fetchJson(`${ITUNES_LOOKUP_URL}?id=${encodeURIComponent(appId)}&country=${encodeURIComponent(country)}`);
      const a = data.results && data.results[0];
      if (a) {
        found++;
        if (a.trackName) titles.add(a.trackName);
        rows.push({
          country,
          countryName: storefrontLabel(country),
          available: true,
          title: a.trackName || null,
          price: a.formattedPrice || null,
          currency: a.currency || null,
          rating: typeof a.averageUserRating === 'number' ? a.averageUserRating : null,
          ratingCount: a.userRatingCount || 0,
          storeLink: a.trackViewUrl || null,
        });
      } else {
        rows.push({ country, countryName: storefrontLabel(country), available: false });
      }
    } catch (err) {
      failed++;
      rows.push({
        country,
        countryName: storefrontLabel(country),
        available: false,
        error: err.message,
      });
    }
    if (i < storefronts.length - 1) await sleep(LOOKUP_DELAY_MS);
  }

  return {
    appId,
    checked: storefronts.length,
    found,
    failed,
    // >1 distinct title among the storefronts that resolved means the
    // listing has been localized -- same signal the source page surfaces.
    distinctTitles: titles.size,
    rows,
  };
}

// The shape of the JSON in structuredContent. Declared so an agent can
// read the result without parsing prose -- and, because the SDK validates
// every success against it, so a handler that quietly stops returning a
// field fails here instead of downstream. Nullable fields below are the
// ones the computation genuinely leaves empty, not defensive padding.
const searchOutputSchema = {
  term: z.string().describe('The search term, echoed back.'),
  country: z.string().describe('The storefront that was searched.'),
  entity: z.string().describe('Which catalogue was searched (iPhone, iPad or Mac software).'),
  resultCount: z.number().int().describe("Apple's own reported match count for the query."),
  capped: z
    .boolean()
    .describe("True when the result hit the Search API's 200-per-request ceiling, meaning there are likely more matches than were returned."),
  apps: z
    .array(
      z.object({
        appId: z.string().nullable().describe('Numeric App Store app ID as a string, or null if Apple omitted it.'),
        title: z.string().nullable().describe('App name on this storefront.'),
        seller: z.string().nullable().describe('Publisher name.'),
        price: z.string().nullable().describe('Formatted price as Apple returns it, including the currency symbol.'),
        currency: z.string().nullable().describe('ISO currency code for that price.'),
        rating: z.number().nullable().describe('Average user rating, or null when the app has none on this storefront.'),
        ratingCount: z.number().int().describe('Number of ratings; 0 when Apple reports none.'),
        storeLink: z.string().nullable().describe('Canonical apps.apple.com URL for the listing.'),
        artworkUrl: z.string().nullable().describe('100px artwork URL.'),
      })
    )
    .describe('The matching apps. Every field is nullable because Apple omits fields per storefront rather than returning empty values.'),
};

// The shape of the JSON in structuredContent. Declared so an agent can
// read the result without parsing prose -- and, because the SDK validates
// every success against it, so a handler that quietly stops returning a
// field fails here instead of downstream. Nullable fields below are the
// ones the computation genuinely leaves empty, not defensive padding.
const compareOutputSchema = {
  appId: z.string().describe('The app ID that was looked up, extracted from the input if a URL was given.'),
  checked: z.number().int().describe('How many storefronts were queried.'),
  found: z.number().int().describe('How many of them have the app listed.'),
  failed: z.number().int().describe('How many lookups errored rather than returning a verdict.'),
  distinctTitles: z
    .number()
    .int()
    .describe('Number of different titles seen across the storefronts that resolved -- more than one means the listing is localized.'),
  rows: z
    .array(
      z.object({
        country: z.string().describe('Storefront code.'),
        countryName: z.string().describe('Storefront name.'),
        available: z.boolean().describe('Whether the app is listed on this storefront. When false, the listing fields below are absent.'),
        title: z.string().nullable().optional().describe('App name on this storefront; present only when available.'),
        price: z.string().nullable().optional().describe('Formatted local price; present only when available.'),
        currency: z.string().nullable().optional().describe('ISO currency code; present only when available.'),
        rating: z.number().nullable().optional().describe('Average rating on this storefront; present only when available.'),
        ratingCount: z.number().int().optional().describe('Rating count on this storefront; present only when available.'),
        storeLink: z.string().nullable().optional().describe('Local listing URL; present only when available.'),
        error: z.string().optional().describe('Why this storefront could not be checked. Present only on a failed lookup, which also reports available:false.'),
      })
    )
    .describe('One row per requested storefront, in the order given. A row is one of three shapes: listed, not listed, or errored.'),
};

function register(server) {
  server.registerTool(
    'appstore_search',
    {
      title: 'Search an App Store storefront',
      description:
        'Searches one Apple App Store country storefront by term, via Apple\'s public iTunes Search API (the same request the GO AI "App Store storefront checker" tool makes from the browser), and returns matching apps with title, seller, price, rating and a direct App Store link. Returns up to 200 results, Apple\'s own per-request maximum -- a result of exactly 200 likely means more exist. Results are ordered by Apple\'s internal relevance, which does not match the ranked list shown in the App Store app, so this cannot be used to track keyword rank.',
      annotations: toolAnnotations.NETWORK,
      outputSchema: searchOutputSchema,
      inputSchema: {
        term: z
          .string()
          .trim()
          .min(1, 'term is required')
          .max(MAX_SEARCH_TERM_CHARS, `term must be ${MAX_SEARCH_TERM_CHARS} characters or fewer`)
          .describe(`Search phrase, up to ${MAX_SEARCH_TERM_CHARS} characters. Sent verbatim to Apple's Search API as the query term.`),
        country: z
          .string()
          .trim()
          .length(2, 'country must be a 2-letter storefront code, e.g. "US"')
          .transform((s) => s.toUpperCase())
          .default('US')
          .describe('2-letter App Store storefront code, e.g. "US", "GB", "JP". Defaults to "US".'),
        entity: z
          .enum(['software', 'iPadSoftware', 'macSoftware'])
          .default('software')
          .describe('App type: "software" (iPhone), "iPadSoftware" (iPad), or "macSoftware" (Mac).'),
      },
    },
    async (args) => {
      try {
        const result = await searchStorefront(args);
        return toolResult.ok(result);
      } catch (err) {
        return toolResult.fail(
          `App Store search failed: ${err.message}. Apple rate-limits this API at roughly 20 calls/minute per IP -- if this followed a burst of calls, wait a moment and retry.`
        );
      }
    }
  );

  server.registerTool(
    'appstore_compare_markets',
    {
      title: 'Compare an App Store listing across markets',
      description:
        'Looks up one app (by numeric App Store id, or a pasted apps.apple.com URL) in up to 30 App Store storefronts in a single call, via Apple\'s public iTunes Lookup API, and reports per-market availability, localized title, price and rating. Capped at 30 storefronts per call by design -- there are 173 total App Store storefronts, and this deliberately never sweeps all of them in one call; call again with a different storefronts list to cover more markets. Lookups run one at a time with a short pause between each (matching the pacing the source browser tool uses for its 30-market quick-compare), so a full 30-market call takes roughly ten seconds, not an instant burst.',
      annotations: toolAnnotations.NETWORK,
      outputSchema: compareOutputSchema,
      inputSchema: {
        appIdOrUrl: z
          .string()
          .trim()
          .min(1, 'appIdOrUrl is required')
          // Long enough for any real apps.apple.com URL, short enough that
          // nothing oversized reaches the id extractor.
          .max(2048)
          .describe('Numeric App Store id (e.g. "6742322421") or a full apps.apple.com URL containing one.'),
        storefronts: z
          .array(z.string().max(16))
          // Bounded at the SCHEMA level, not only by the post-normalize check
          // below: normalizeStorefronts() de-duplicates, so a 1,000,000-entry
          // array of "US" used to normalize down to a single passing code
          // after a million iterations of trim/uppercase/regex.
          .max(MAX_STOREFRONTS_PER_CALL * 4)
          .optional()
          .describe(
            `Up to ${MAX_STOREFRONTS_PER_CALL} 2-letter storefront codes (e.g. ["US","GB","JP"]) after de-duplication. Omit to use the same 30 major markets the source tool defaults to.`
          ),
      },
    },
    async (args) => {
      const appId = extractAppId(args.appIdOrUrl);
      if (!appId) {
        // The input is truncated in the message: it is caller-controlled and
        // echoing it whole would let a 2 KB argument become a 2 KB error.
        const shown = String(args.appIdOrUrl).slice(0, 80);
        return toolResult.fail(
          `Could not find a usable numeric App Store id in "${shown}" -- pass a numeric id of at most ` +
            `${MAX_APP_ID_DIGITS} digits (e.g. "6742322421") or a full apps.apple.com link that contains one.`
        );
      }

      const { storefronts, invalid } = normalizeStorefronts(args.storefronts);
      if (storefronts.length === 0) {
        return toolResult.fail(
          'No valid 2-letter storefront codes were given (e.g. "US", "GB", "JP").'
        );
      }
      if (storefronts.length > MAX_STOREFRONTS_PER_CALL) {
        return toolResult.fail(
          `Requested ${storefronts.length} storefronts; up to ${MAX_STOREFRONTS_PER_CALL} are allowed per call. There are 173 App Store storefronts in total -- this tool deliberately never sweeps all of them in one call to stay well under Apple's rate limit. Call again with a different subset for additional markets.`
        );
      }

      try {
        const result = await compareAcrossMarkets({ appId, storefronts });
        if (invalid && invalid.length) {
          result.ignoredInput = invalid;
        }
        return toolResult.ok(result);
      } catch (err) {
        return toolResult.fail(`App Store comparison failed: ${err.message}`);
      }
    }
  );
}

module.exports = {
  register,
  toolCount: 2,
  extractAppId,
  normalizeStorefronts,
  searchStorefront,
  compareAcrossMarkets,
  MAJOR_MARKETS,
  MAX_STOREFRONTS_PER_CALL,
  MAX_APP_ID_DIGITS,
  MAX_SEARCH_TERM_CHARS,
  STOREFRONTS,
};
