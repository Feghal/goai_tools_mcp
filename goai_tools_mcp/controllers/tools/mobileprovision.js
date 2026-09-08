'use strict';

const { z } = require('zod');
const { DOMParser } = require('@xmldom/xmldom');
const toolResult = require('../../utils/toolResult');
const toolAnnotations = require('../../utils/toolAnnotations');
const byteLimits = require('../../utils/byteLimits');

// Ported from nginx/sites/goai/tools/mobileprovision.html. A .mobileprovision
// / .provisionprofile is a CMS/PKCS7-signed blob, but the plist payload inside
// it is stored as plain XML, so the source (and this port) never touches the
// signature: the whole job is locating '<?xml' ... '</plist>' by byte search
// and parsing whatever text sits between them.

const ERROR_MESSAGES = {
  unreadable_bytes: 'That file could not be read.',
  no_plist_markers: 'No property list found inside that file. Is it really a provisioning profile?',
  malformed_xml: 'The property list inside could not be parsed.',
  plist_too_large: 'The property list inside that file is too large to parse.',
  plist_too_deep: 'The property list inside that file is nested too deeply to parse.',
};

// A real provisioning profile is 8-12 KB, and the plist inside it is smaller
// still. 2 MB is two orders of magnitude of headroom and keeps the DOM (which
// costs several times the source text in objects) bounded -- the whole XML
// string is also returned to the caller as `rawPlistXml`, so this doubles as
// the bound on the response.
const MAX_PLIST_CHARS = 2 * 1000 * 1000;

// parseNode() below recurses once per nesting level. Verified: ~50,000 nested
// <array> elements overflows V8's stack with a RangeError. It is caught by
// register()'s try/catch and reported as a failure rather than crashing the
// process, but a stack overflow is not a condition to rely on catching in a
// long-lived shared process -- so the depth is bounded explicitly instead.
// Apple's own plists nest a handful of levels deep.
const MAX_PLIST_DEPTH = 100;

class PlistTooDeepError extends Error {}

// Source: `extractPlist(bytes)`. Decodes with a non-fatal UTF-8 TextDecoder
// (exactly like the browser source) so binary CMS bytes surrounding the
// plist never throw, then finds the two textual boundaries.
function extractPlist(bytes) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const start = text.indexOf('<?xml');
  const end = text.indexOf('</plist>');
  if (start < 0 || end < 0 || end < start) return null;
  return text.slice(start, end + 8);
}

// @xmldom/xmldom has no `firstElementChild` on Element (it's `undefined`,
// unlike a browser DOM) -- this is a direct port of what the browser
// property does: the first child node that is an element (nodeType === 1).
function firstElementChild(node) {
  if (!node) return null;
  const kids = node.childNodes;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].nodeType === 1) return kids[i];
  }
  return null;
}

// Source: `parseNode(node)`, ported as-is. @xmldom's `.children` /
// `.textContent` behave the same as the browser DOM here, so no other
// change was needed.
function parseNode(node, depth) {
  const d = depth || 0;
  // Guards the recursion below; see MAX_PLIST_DEPTH.
  if (d > MAX_PLIST_DEPTH) throw new PlistTooDeepError('plist nesting exceeded');
  switch (node.nodeName) {
    case 'dict': {
      const out = {};
      let key = null;
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child.nodeName === 'key') key = child.textContent;
        else if (key !== null) {
          out[key] = parseNode(child, d + 1);
          key = null;
        }
      }
      return out;
    }
    case 'array': {
      const list = [];
      for (let j = 0; j < node.children.length; j++) list.push(parseNode(node.children[j], d + 1));
      return list;
    }
    case 'true':
      return true;
    case 'false':
      return false;
    case 'integer':
      return parseInt(node.textContent, 10);
    case 'real':
      return parseFloat(node.textContent);
    case 'date':
      return new Date(node.textContent);
    case 'data':
      return { data: node.textContent.replace(/\s+/g, '') };
    default:
      return node.textContent;
  }
}

// Source: `parsePlist(xml)`. A browser DOMParser reports malformed XML by
// injecting a <parsererror> element into the document it still returns;
// @xmldom instead *throws* a ParseError for the same fatal condition, so
// that throw is this port's "malformed XML" signal. The getElementsByTagName
// check is kept for parity with the source but is effectively unreachable
// under @xmldom, which never produces that element.
function parsePlist(xml) {
  let doc;
  try {
    doc = new DOMParser({ onError: () => {} }).parseFromString(xml, 'application/xml');
  } catch (e) {
    return null;
  }
  if (!doc || doc.getElementsByTagName('parsererror').length) return null;
  const root = firstElementChild(doc.documentElement);
  return root ? parseNode(root, 0) : null;
}

function hasDate(d) {
  return d instanceof Date && !isNaN(d);
}

// Source used `toLocaleDateString(undefined, {...})`, i.e. the browser's
// locale. There is no equivalent "caller's locale" on the server, so this
// port fixes it to en-US.
function fmtDate(d) {
  return hasDate(d) ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
}

// JSON.stringify already turns a Date into an ISO string via toJSON, but we
// do it explicitly so structuredContent is legible without relying on that.
function toJsonSafe(v) {
  if (hasDate(v)) return v.toISOString();
  if (v instanceof Date) return null; // invalid Date
  if (Array.isArray(v)) return v.map(toJsonSafe);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = toJsonSafe(v[k]);
    return out;
  }
  return v;
}

// Source: the `kind` line inside `show()`.
//
// DEVIATION FROM TASK HINT: the hint describes this classification as
// derived "from ProvisionsAllDevices + Entitlements + get-task-allow", but
// the actual source page never reads Entitlements or get-task-allow for
// this decision -- it is purely ProvisionedDevices.length, then
// ProvisionsAllDevices. Ported exactly as the source has it, not as the
// hint describes it.
function classifyProfileType(p) {
  const devices = Array.isArray(p.ProvisionedDevices) ? p.ProvisionedDevices : [];
  if (devices.length) {
    return { kind: 'development', description: 'Development or ad hoc — installs only on the listed devices' };
  }
  if (p.ProvisionsAllDevices) {
    return { kind: 'enterprise', description: 'Enterprise — installs on any device' };
  }
  return { kind: 'app_store', description: 'App Store distribution — for submission, not direct install' };
}

// Source: the body of `show(p, xml)`, minus DOM writes -- turned into a
// plain structured report instead of table rows and coloured text.
function buildReport(p, xml) {
  const now = new Date();
  const expires = p.ExpirationDate;
  const created = p.CreationDate;
  const validExpiry = hasDate(expires);
  const daysRemaining = validExpiry ? Math.round((expires - now) / 86400000) : null;

  let status = 'unknown';
  let message = '';
  if (validExpiry) {
    const dateStr = fmtDate(expires);
    if (daysRemaining < 0) {
      status = 'expired';
      message = `Expired ${Math.abs(daysRemaining)} days ago, on ${dateStr}`;
    } else if (daysRemaining <= 30) {
      status = 'expiring_soon';
      message = `Expires in ${daysRemaining} days, on ${dateStr}`;
    } else {
      status = 'valid';
      message = `Valid until ${dateStr}, ${daysRemaining} days from now`;
    }
  }

  const devices = Array.isArray(p.ProvisionedDevices) ? p.ProvisionedDevices : [];
  const certificates = Array.isArray(p.DeveloperCertificates) ? p.DeveloperCertificates : [];
  const ent = p.Entitlements && typeof p.Entitlements === 'object' ? p.Entitlements : {};

  return {
    ok: true,
    name: p.Name || null,
    appIdName: p.AppIDName || null,
    applicationIdentifier: ent['application-identifier'] || ent['com.apple.application-identifier'] || null,
    teamName: p.TeamName || null,
    teamIdentifier: p.TeamIdentifier !== undefined ? toJsonSafe(p.TeamIdentifier) : null,
    uuid: p.UUID || null,
    platform: p.Platform !== undefined ? toJsonSafe(p.Platform) : null,
    createdDate: hasDate(created) ? created.toISOString() : null,
    expirationDate: validExpiry ? expires.toISOString() : null,
    timeToLiveDays: p.TimeToLive === undefined ? null : p.TimeToLive,
    expiry: { status, daysRemaining, message },
    profileType: classifyProfileType(p),
    certificateCount: certificates.length,
    deviceCount: devices.length,
    devices,
    entitlements: toJsonSafe(ent),
    rawPlistXml: xml,
  };
}

// Source: the FileReader.onload / onerror wiring in the change handler,
// collapsed into one pure function that distinguishes the same three
// failure modes the page does instead of throwing:
//   - unreadable bytes    (source: fr.onerror -> S.broken)
//   - no plist markers    (source: extractPlist() -> null -> S.noPlist)
//   - malformed XML       (source: parsePlist() -> null -> S.badPlist)
//
// DEVIATION: the browser's fr.onerror fires on a genuine FileReader I/O
// failure, which has no direct analogue for an in-memory base64 argument.
// The closest server-side equivalent -- and the only realistic way to hit
// this branch here -- is missing/empty input, so that is what maps to
// 'unreadable_bytes'. Garbage-but-present bytes fall through to
// 'no_plist_markers' exactly as they would in the browser (a FileReader
// read of a non-profile file also succeeds; it's extractPlist that fails).
function inspectMobileprovision(base64) {
  if (typeof base64 !== 'string' || base64.trim() === '') {
    return { ok: false, error: 'unreadable_bytes', message: ERROR_MESSAGES.unreadable_bytes };
  }

  // byteLimits.decode() throws InputTooLargeError for an oversized input --
  // that is a distinct, size-limit failure, not one of the three modes
  // above, so it is left to propagate to the caller's try/catch.
  const bytes = byteLimits.decode(base64);
  if (!bytes || bytes.length === 0) {
    return { ok: false, error: 'unreadable_bytes', message: ERROR_MESSAGES.unreadable_bytes };
  }

  const xml = extractPlist(bytes);
  if (!xml) {
    return { ok: false, error: 'no_plist_markers', message: ERROR_MESSAGES.no_plist_markers };
  }
  // Checked before parsing: the DOM costs several times the source text, and
  // the same string is returned whole as `rawPlistXml`.
  if (xml.length > MAX_PLIST_CHARS) {
    return { ok: false, error: 'plist_too_large', message: ERROR_MESSAGES.plist_too_large };
  }

  let parsed;
  try {
    parsed = parsePlist(xml);
  } catch (err) {
    if (err instanceof PlistTooDeepError) {
      return { ok: false, error: 'plist_too_deep', message: ERROR_MESSAGES.plist_too_deep };
    }
    throw err;
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'malformed_xml', message: ERROR_MESSAGES.malformed_xml };
  }

  return buildReport(parsed, xml);
}

// The shape of the JSON in structuredContent. Declared so an agent can
// read the result without parsing prose -- and, because the SDK validates
// every success against it, so a handler that quietly stops returning a
// field fails here instead of downstream. Nullable fields below are the
// ones the computation genuinely leaves empty, not defensive padding.
//
// Three fields are deliberately typed loose (z.unknown): teamIdentifier,
// platform and each device entry are reflected straight back out of a
// caller-supplied plist, so their real type is whatever that file held. A
// tighter declaration here would reject an unusual but perfectly readable
// profile, which is the one failure mode this tool must not have.
const mobileprovisionOutputSchema = {
  ok: z
    .literal(true)
    .describe('Always true on a readable profile. An unreadable file, a file with no embedded plist, or a plist that will not parse comes back as an error result instead, with the reason as its text.'),
  name: z.string().nullable().describe("The profile's name, or null if the plist omits it."),
  appIdName: z.string().nullable().describe('The App ID name registered with the profile.'),
  applicationIdentifier: z
    .string()
    .nullable()
    .describe("The application-identifier entitlement, i.e. team ID plus bundle ID -- the field that says what this profile actually signs."),
  teamName: z.string().nullable().describe('Developer team name.'),
  teamIdentifier: z.unknown().describe('Team identifiers from the plist, normally an array of one team ID string. Null when absent.'),
  uuid: z.string().nullable().describe("The profile's UUID."),
  platform: z.unknown().describe("Platforms the profile covers, normally an array such as ['ios']. Null when absent."),
  createdDate: z.string().nullable().describe('Creation date as an ISO 8601 string, or null when absent or unparseable.'),
  expirationDate: z.string().nullable().describe('Expiry date as an ISO 8601 string, or null when absent or unparseable.'),
  timeToLiveDays: z.number().nullable().describe('The profile\'s TimeToLive in days, or null when absent.'),
  expiry: z
    .object({
      status: z
        .enum(['valid', 'expiring_soon', 'expired', 'unknown'])
        .describe("Expiry verdict; 'expiring_soon' means 30 days or fewer remain, 'unknown' means the profile carried no readable expiry date."),
      daysRemaining: z.number().nullable().describe('Days until expiry, negative once expired. Null when status is unknown.'),
      message: z.string().describe('That verdict written out with the date. An empty string when status is unknown.'),
    })
    .describe('Whether this profile still works, which is the question most callers are actually asking.'),
  profileType: z
    .object({
      kind: z
        .enum(['development', 'enterprise', 'app_store'])
        .describe('Profile kind, inferred from the registered-device list and the ProvisionsAllDevices flag -- not from a field that states it, because none does.'),
      description: z.string().describe('What that kind means for installing the build.'),
    })
    .describe('Development/ad hoc vs. enterprise vs. App Store distribution.'),
  certificateCount: z
    .number()
    .int()
    .describe('How many signing certificates are embedded. The certificates themselves are not decoded -- only counted.'),
  deviceCount: z.number().int().describe('Number of registered device UDIDs; 0 for an App Store or enterprise profile.'),
  devices: z.array(z.unknown()).describe('The registered device UDIDs, normally strings. Empty when the profile registers none.'),
  entitlements: z
    .record(z.string(), z.unknown())
    .describe('The full entitlements dictionary verbatim from the profile, keys and values as the plist held them.'),
  rawPlistXml: z.string().describe('The embedded property list as raw XML, for anything this report does not surface.'),
};

function register(server) {
  server.registerTool(
    'inspect_mobileprovision',
    {
      title: 'Inspect a provisioning profile',
      description:
        "Reads an iOS/macOS provisioning profile (.mobileprovision or .provisionprofile, given as base64) by byte-searching its CMS/PKCS7-signed container for the embedded '<?xml ... </plist>' property list and parsing that XML -- it never validates or decodes the cryptographic signature, and does not report on the embedded certificates beyond how many there are. Reports expiry status and days remaining, profile type (development/ad hoc vs. enterprise vs. App Store distribution, classified only from the registered-device list and the ProvisionsAllDevices flag), team and application identifiers, the full entitlements dictionary, and the count and UDIDs of registered devices. Returns a structured { ok: false, error, message } result (not a thrown error) for an unreadable input, a file with no embedded plist, or a plist that fails to parse.",
      annotations: toolAnnotations.PURE,
      outputSchema: mobileprovisionOutputSchema,
      inputSchema: {
        base64: z.string().min(1).describe('Base64-encoded raw bytes of the .mobileprovision or .provisionprofile file.'),
      },
    },
    async (args) => {
      try {
        const result = inspectMobileprovision(args.base64);
        if (!result.ok) return toolResult.fail(result.message);
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
  inspectMobileprovision,
  MAX_PLIST_CHARS,
  MAX_PLIST_DEPTH,
};
