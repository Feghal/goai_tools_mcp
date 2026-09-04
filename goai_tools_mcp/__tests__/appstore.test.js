'use strict';

const path = require('path');
const appstore = require('../controllers/tools/appstore');

const searchFixture = require('./fixtures/appstore-search-us.json');
const lookupFoundFixture = require('./fixtures/appstore-lookup-us.json');
const lookupNotFoundFixture = require('./fixtures/appstore-lookup-notfound.json');

// A minimal stand-in for the real McpServer: register() just needs an object
// with a registerTool(name, def, handler) method, and these tests only care
// about capturing the handlers it's called with.
function makeFakeServer() {
  const tools = {};
  return {
    registerTool(name, def, handler) {
      tools[name] = { def, handler };
    },
    tools,
  };
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function jsonResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

describe('appstore.js pure logic (no network)', () => {
  test('extractAppId reads a bare numeric id', () => {
    expect(appstore.extractAppId('6742322421')).toBe('6742322421');
  });

  test('extractAppId reads the id out of a full apps.apple.com URL', () => {
    expect(
      appstore.extractAppId('https://apps.apple.com/us/app/go-ai-chat/id6742322421?uo=4')
    ).toBe('6742322421');
  });

  test('extractAppId returns null when there is no id-shaped number', () => {
    expect(appstore.extractAppId('not an id')).toBeNull();
    expect(appstore.extractAppId('12345')).toBeNull(); // fewer than 6 digits
  });

  test('normalizeStorefronts defaults to the 30 major markets when omitted', () => {
    const { storefronts, usedDefault } = appstore.normalizeStorefronts(undefined);
    expect(usedDefault).toBe(true);
    expect(storefronts).toEqual(appstore.MAJOR_MARKETS);
    expect(storefronts.length).toBe(30);
  });

  test('normalizeStorefronts trims, uppercases, dedupes, and drops malformed codes', () => {
    const { storefronts, invalid } = appstore.normalizeStorefronts(['us', ' gb ', 'US', 'XYZ', 123]);
    expect(storefronts).toEqual(['US', 'GB']);
    expect(invalid).toEqual(expect.arrayContaining(['XYZ', '123']));
  });

  test('the 30-storefront cap constant matches what the tool enforces', () => {
    expect(appstore.MAX_STOREFRONTS_PER_CALL).toBe(30);
  });
});

describe('appstore_compare_markets storefront-count clamp (no network should occur)', () => {
  test('rejects a request for more than 30 storefronts without ever calling fetch', async () => {
    global.fetch = jest.fn(() => {
      throw new Error('fetch should not have been called for an over-limit request');
    });

    const server = makeFakeServer();
    appstore.register(server);

    const tooMany = Array.from({ length: 31 }, (_, i) => appstore.STOREFRONTS[i % appstore.STOREFRONTS.length][0]);
    const res = await server.tools.appstore_compare_markets.handler({
      appIdOrUrl: '6742322421',
      storefronts: tooMany,
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/30/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects when no valid storefront codes survive normalization', async () => {
    global.fetch = jest.fn(() => {
      throw new Error('fetch should not have been called');
    });
    const server = makeFakeServer();
    appstore.register(server);

    const res = await server.tools.appstore_compare_markets.handler({
      appIdOrUrl: '6742322421',
      storefronts: ['XYZ', '1'],
    });

    expect(res.isError).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects an appIdOrUrl with no extractable id without calling fetch', async () => {
    global.fetch = jest.fn(() => {
      throw new Error('fetch should not have been called');
    });
    const server = makeFakeServer();
    appstore.register(server);

    const res = await server.tools.appstore_compare_markets.handler({
      appIdOrUrl: 'not-an-id',
    });

    expect(res.isError).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('appstore_search against a mocked fetch (real captured fixture)', () => {
  test('maps Apple\'s search response into the documented shape', async () => {
    global.fetch = jest.fn((url) => {
      expect(String(url)).toContain('itunes.apple.com/search');
      expect(String(url)).toContain('term=ai%20video%20generator');
      return jsonResponse(searchFixture);
    });

    const server = makeFakeServer();
    appstore.register(server);

    const res = await server.tools.appstore_search.handler({
      term: 'ai video generator',
      country: 'US',
      entity: 'software',
    });

    expect(res.isError).toBeUndefined();
    const data = res.structuredContent;
    expect(data.term).toBe('ai video generator');
    expect(data.country).toBe('US');
    expect(data.resultCount).toBe(searchFixture.resultCount);
    expect(data.capped).toBe(false); // fixture is a small capture, well under 200
    expect(data.apps).toHaveLength(searchFixture.results.length);

    const first = data.apps[0];
    const fixtureFirst = searchFixture.results[0];
    expect(first.title).toBe(fixtureFirst.trackName);
    expect(first.seller).toBe(fixtureFirst.sellerName);
    expect(first.price).toBe(fixtureFirst.formattedPrice);
    expect(first.rating).toBe(fixtureFirst.averageUserRating);
    expect(first.storeLink).toBe(fixtureFirst.trackViewUrl);
    expect(first.appId).toBe(String(fixtureFirst.trackId));

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('reports a clear failure when Apple responds with a non-OK status', async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) }));

    const server = makeFakeServer();
    appstore.register(server);

    const res = await server.tools.appstore_search.handler({ term: 'anything', country: 'US', entity: 'software' });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/403|rate/i);
  });
});

describe('appstore_compare_markets against a mocked fetch (real captured fixtures)', () => {
  test('reports availability, title, price and rating per storefront, and tallies found/failed', async () => {
    global.fetch = jest.fn((url) => {
      const u = new URL(url);
      const country = u.searchParams.get('country');
      expect(u.pathname).toBe('/lookup');
      expect(u.searchParams.get('id')).toBe('6742322421');
      if (country === 'US') return jsonResponse(lookupFoundFixture);
      if (country === 'CN') return jsonResponse(lookupNotFoundFixture);
      return Promise.reject(new Error('unexpected country in test: ' + country));
    });

    const server = makeFakeServer();
    appstore.register(server);

    const res = await server.tools.appstore_compare_markets.handler({
      appIdOrUrl: 'https://apps.apple.com/us/app/go-ai-chat/id6742322421',
      storefronts: ['US', 'CN'],
    });

    expect(res.isError).toBeUndefined();
    const data = res.structuredContent;
    expect(data.appId).toBe('6742322421');
    expect(data.checked).toBe(2);
    expect(data.found).toBe(1);
    expect(data.failed).toBe(0);

    const usRow = data.rows.find((r) => r.country === 'US');
    const cnRow = data.rows.find((r) => r.country === 'CN');
    const fixtureApp = lookupFoundFixture.results[0];

    expect(usRow.available).toBe(true);
    expect(usRow.title).toBe(fixtureApp.trackName);
    expect(usRow.price).toBe(fixtureApp.formattedPrice);
    expect(usRow.rating).toBe(fixtureApp.averageUserRating);
    expect(usRow.storeLink).toBe(fixtureApp.trackViewUrl);

    expect(cnRow.available).toBe(false);
    expect(cnRow.title).toBeUndefined();

    expect(global.fetch).toHaveBeenCalledTimes(2);
  }, 10000);

  test('marks a per-storefront network failure without aborting the rest of the sweep', async () => {
    global.fetch = jest.fn((url) => {
      const u = new URL(url);
      const country = u.searchParams.get('country');
      if (country === 'US') return Promise.reject(new Error('network down'));
      return jsonResponse(lookupNotFoundFixture);
    });

    const server = makeFakeServer();
    appstore.register(server);

    const res = await server.tools.appstore_compare_markets.handler({
      appIdOrUrl: '6742322421',
      storefronts: ['US', 'FR'],
    });

    const data = res.structuredContent;
    expect(data.failed).toBe(1);
    expect(data.found).toBe(0);
    const usRow = data.rows.find((r) => r.country === 'US');
    expect(usRow.available).toBe(false);
    expect(usRow.error).toMatch(/network down/);
    const frRow = data.rows.find((r) => r.country === 'FR');
    expect(frRow.available).toBe(false);
    expect(frRow.error).toBeUndefined();
  }, 10000);
});
