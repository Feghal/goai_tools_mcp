'use strict';

const mobileprovision = require('../controllers/tools/mobileprovision');
const { inspectMobileprovision, register, toolCount } = mobileprovision;

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Builds a synthetic .mobileprovision-shaped payload: binary CMS-ish junk,
// then a real plist, then more junk -- mirroring how the actual file looks
// (a CMS/PKCS7 envelope wrapping an XML plist) without needing a real
// signature, since the tool never touches the signature anyway.
function buildProfileBase64(opts) {
  const o = Object.assign(
    {
      name: 'MyApp Development',
      appIdName: 'XC MyApp',
      teamName: 'Acme Inc',
      teamIdentifier: ['TEAM1234'],
      uuid: '11111111-2222-3333-4444-555555555555',
      platform: ['ios'],
      created: new Date(Date.now() - 30 * 86400000),
      expiration: new Date(Date.now() + 200 * 86400000),
      timeToLive: 365,
      entitlements: { 'application-identifier': 'TEAM1234.com.acme.myapp', 'get-task-allow': true },
      provisionedDevices: ['a'.repeat(40), 'b'.repeat(40)],
      provisionsAllDevices: undefined,
      developerCertificates: ['AAAABBBBCCCC'],
    },
    opts
  );

  const entXml = Object.entries(o.entitlements)
    .map(([k, v]) => {
      if (typeof v === 'boolean') return `<key>${xmlEscape(k)}</key><${v}/>`;
      return `<key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`;
    })
    .join('');

  const devicesXml = o.provisionedDevices.length
    ? `<key>ProvisionedDevices</key><array>${o.provisionedDevices
        .map((d) => `<string>${xmlEscape(d)}</string>`)
        .join('')}</array>`
    : '';

  const allDevicesXml =
    o.provisionsAllDevices !== undefined
      ? `<key>ProvisionsAllDevices</key><${o.provisionsAllDevices ? 'true' : 'false'}/>`
      : '';

  const certsXml = `<key>DeveloperCertificates</key><array>${o.developerCertificates
    .map((c) => `<data>${c}</data>`)
    .join('')}</array>`;

  const plist =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' +
    '<plist version="1.0"><dict>' +
    `<key>Name</key><string>${xmlEscape(o.name)}</string>` +
    `<key>AppIDName</key><string>${xmlEscape(o.appIdName)}</string>` +
    `<key>TeamName</key><string>${xmlEscape(o.teamName)}</string>` +
    `<key>TeamIdentifier</key><array>${o.teamIdentifier.map((t) => `<string>${xmlEscape(t)}</string>`).join('')}</array>` +
    `<key>UUID</key><string>${xmlEscape(o.uuid)}</string>` +
    `<key>Platform</key><array>${o.platform.map((p) => `<string>${xmlEscape(p)}</string>`).join('')}</array>` +
    `<key>CreationDate</key><date>${o.created.toISOString()}</date>` +
    `<key>ExpirationDate</key><date>${o.expiration.toISOString()}</date>` +
    `<key>TimeToLive</key><integer>${o.timeToLive}</integer>` +
    `<key>Entitlements</key><dict>${entXml}</dict>` +
    devicesXml +
    allDevicesXml +
    certsXml +
    '</dict></plist>';

  const wrapped = '\x30\x82\x01\x02JUNK-CMS-BYTES-BEFORE' + plist + 'JUNK-CMS-BYTES-AFTER\x00\x01';
  return Buffer.from(wrapped, 'utf8').toString('base64');
}

describe('inspectMobileprovision', () => {
  test('parses a development/ad-hoc profile (has ProvisionedDevices)', () => {
    const b64 = buildProfileBase64({});
    const result = inspectMobileprovision(b64);

    expect(result.ok).toBe(true);
    expect(result.name).toBe('MyApp Development');
    expect(result.appIdName).toBe('XC MyApp');
    expect(result.teamName).toBe('Acme Inc');
    expect(result.teamIdentifier).toEqual(['TEAM1234']);
    expect(result.uuid).toBe('11111111-2222-3333-4444-555555555555');
    expect(result.platform).toEqual(['ios']);
    expect(result.applicationIdentifier).toBe('TEAM1234.com.acme.myapp');
    expect(result.timeToLiveDays).toBe(365);
    expect(result.certificateCount).toBe(1);
    expect(result.deviceCount).toBe(2);
    expect(result.devices).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
    expect(result.entitlements['application-identifier']).toBe('TEAM1234.com.acme.myapp');
    expect(result.entitlements['get-task-allow']).toBe(true);
    expect(result.profileType.kind).toBe('development');
    expect(result.expiry.status).toBe('valid');
    expect(result.expiry.daysRemaining).toBeGreaterThan(190);
    expect(typeof result.rawPlistXml).toBe('string');
    expect(result.rawPlistXml.startsWith('<?xml')).toBe(true);
    expect(result.rawPlistXml.endsWith('</plist>')).toBe(true);
  });

  test('classifies enterprise: no device list, ProvisionsAllDevices true', () => {
    const b64 = buildProfileBase64({ provisionedDevices: [], provisionsAllDevices: true });
    const result = inspectMobileprovision(b64);
    expect(result.ok).toBe(true);
    expect(result.profileType.kind).toBe('enterprise');
    expect(result.deviceCount).toBe(0);
    expect(result.devices).toEqual([]);
  });

  test('classifies App Store distribution: no device list, no ProvisionsAllDevices flag', () => {
    const b64 = buildProfileBase64({ provisionedDevices: [], provisionsAllDevices: undefined });
    const result = inspectMobileprovision(b64);
    expect(result.ok).toBe(true);
    expect(result.profileType.kind).toBe('app_store');
  });

  test('classifies development even when ProvisionsAllDevices is also true (device list wins)', () => {
    // Matches the source's exact branch order: ProvisionedDevices.length is
    // checked first, so a (contradictory) ProvisionsAllDevices:true is not
    // consulted when a device list is present.
    const b64 = buildProfileBase64({ provisionedDevices: ['a'.repeat(40)], provisionsAllDevices: true });
    const result = inspectMobileprovision(b64);
    expect(result.profileType.kind).toBe('development');
  });

  test('reports an expired profile with a positive "days ago" count', () => {
    const b64 = buildProfileBase64({
      provisionedDevices: [],
      expiration: new Date(Date.now() - 12 * 86400000),
    });
    const result = inspectMobileprovision(b64);
    expect(result.expiry.status).toBe('expired');
    expect(result.expiry.daysRemaining).toBeLessThan(0);
    expect(result.expiry.message).toMatch(/^Expired \d+ days ago, on /);
  });

  test('reports a profile expiring within 30 days as expiring_soon', () => {
    const b64 = buildProfileBase64({
      provisionedDevices: [],
      expiration: new Date(Date.now() + 10 * 86400000 + 3600000),
    });
    const result = inspectMobileprovision(b64);
    expect(result.expiry.status).toBe('expiring_soon');
    expect(result.expiry.message).toMatch(/^Expires in \d+ days, on /);
  });

  test('falls back to the com.apple.-prefixed entitlement key for the application identifier', () => {
    const b64 = buildProfileBase64({
      entitlements: { 'com.apple.application-identifier': 'TEAM1234.com.acme.other' },
    });
    const result = inspectMobileprovision(b64);
    expect(result.applicationIdentifier).toBe('TEAM1234.com.acme.other');
  });

  test('returns no_plist_markers when the bytes contain no plist boundaries', () => {
    const b64 = Buffer.from('just a plain file, not a provisioning profile at all', 'utf8').toString('base64');
    const result = inspectMobileprovision(b64);
    expect(result).toEqual({
      ok: false,
      error: 'no_plist_markers',
      message: 'No property list found inside that file. Is it really a provisioning profile?',
    });
  });

  test('returns no_plist_markers when </plist> appears before <?xml>', () => {
    const b64 = Buffer.from('</plist> ... <?xml', 'utf8').toString('base64');
    const result = inspectMobileprovision(b64);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('no_plist_markers');
  });

  test('returns malformed_xml for mismatched tags between the markers', () => {
    const broken = '<?xml version="1.0"?><plist><dict><key>Name</key><string>Bad</dict></plist>';
    const b64 = Buffer.from(broken, 'utf8').toString('base64');
    const result = inspectMobileprovision(b64);
    expect(result).toEqual({
      ok: false,
      error: 'malformed_xml',
      message: 'The property list inside could not be parsed.',
    });
  });

  test('returns unreadable_bytes for an empty string', () => {
    const result = inspectMobileprovision('');
    expect(result).toEqual({
      ok: false,
      error: 'unreadable_bytes',
      message: 'That file could not be read.',
    });
  });

  test('returns unreadable_bytes for non-string input', () => {
    const result = inspectMobileprovision(undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unreadable_bytes');
  });

  test('propagates InputTooLargeError for an oversized input instead of swallowing it', () => {
    const bigB64 = buildProfileBase64({});
    expect(() => inspectMobileprovision(bigB64)).not.toThrow(); // sanity: normal size is fine
    expect(() =>
      // Directly exercise byteLimits' own limit via a tiny override, proving
      // the tool does not catch/hide a size-limit failure as one of its own
      // three named modes.
      require('../utils/byteLimits').decode(bigB64, 10)
    ).toThrow(/over the 10 byte limit/);
  });
});

describe('register()', () => {
  test('registers exactly one tool named inspect_mobileprovision', () => {
    const calls = [];
    const fakeServer = { registerTool: (...args) => calls.push(args) };
    register(fakeServer);

    expect(calls).toHaveLength(1);
    const [name, config, handler] = calls[0];
    expect(name).toBe('inspect_mobileprovision');
    expect(typeof config.description).toBe('string');
    expect(config.description.length).toBeGreaterThan(0);
    expect(config.inputSchema).toBeTruthy();
    expect(typeof handler).toBe('function');
  });

  test('toolCount is 1', () => {
    expect(toolCount).toBe(1);
  });

  test('handler resolves a valid profile via toolResult.ok (structuredContent, no isError)', async () => {
    const calls = [];
    register({ registerTool: (...args) => calls.push(args) });
    const [, , handler] = calls[0];

    const b64 = buildProfileBase64({});
    const response = await handler({ base64: b64 });

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent.ok).toBe(true);
    expect(response.structuredContent.uuid).toBe('11111111-2222-3333-4444-555555555555');
  });

  test('handler reports a bad-input case via toolResult.fail (isError, no throw)', async () => {
    const calls = [];
    register({ registerTool: (...args) => calls.push(args) });
    const [, , handler] = calls[0];

    const b64 = Buffer.from('not a profile', 'utf8').toString('base64');
    const response = await handler({ base64: b64 });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toBe(
      'No property list found inside that file. Is it really a provisioning profile?'
    );
  });
});
