'use strict';

// Small RFC 5545 (iCalendar) writer, shared by any tool that needs to hand
// back a real .ics file rather than just numbers. Ported from
// nginx/sites/goai/tools/watering.html's inline escapeText()/fold()/
// stamp()/ics() helpers, generalized to take an arbitrary list of events
// instead of being wired to that one page's plant data.

// RFC 5545 §3.3.11 TEXT escaping: backslash, semicolon, comma and embedded
// newlines each need a leading backslash.
//
// The source page's own escapeText() has a bug here: its
// `.replace(/;/g, '\;')` uses the JS string literal `'\;'`, which — a
// backslash before a character that isn't a recognized escape target is
// simply dropped — evaluates to a bare `;`, so that line never actually
// escapes semicolons. It never shows up on the site because none of its
// fixed vocabulary (plant names, event title/body text) contains a
// semicolon. This shared writer is used from more than one call site, so it
// implements the escape correctly rather than reproducing that no-op; for
// plant-watering.js specifically this makes no observable difference, since
// none of its strings contain a semicolon either way.
function escapeText(v) {
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

// RFC 5545 §3.1: a content line SHOULD be folded before it exceeds 75
// octets (counted in bytes, not characters), and a fold must never land
// inside a multi-byte UTF-8 sequence — which is what makes some calendar
// clients reject an otherwise-valid file outright. Each continuation line
// is rejoined with CRLF plus a single leading space, and that space itself
// counts against the 75-octet budget, hence the 74-byte payload limit from
// the second chunk on.
function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const chunks = [];
  let at = 0;
  let limit = 75;
  while (at < bytes.length) {
    let take = Math.min(limit, bytes.length - at);
    // Step back off a UTF-8 continuation byte (10xxxxxx) so a multi-byte
    // character is never split across two folded lines.
    while (take > 1 && at + take < bytes.length && (bytes[at + take] & 0xc0) === 0x80) take--;
    chunks.push(bytes.subarray(at, at + take).toString('utf8'));
    at += take;
    limit = 74; // continuation lines carry a leading space
  }
  return chunks.join('\r\n ');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// UTC timestamp for DTSTAMP, e.g. 20260315T140501Z.
function formatUtcStamp(date) {
  return (
    date.getUTCFullYear() +
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    'T' +
    pad2(date.getUTCHours()) +
    pad2(date.getUTCMinutes()) +
    pad2(date.getUTCSeconds()) +
    'Z'
  );
}

// Builds a full VCALENDAR document from a flat list of all-day, recurring
// VEVENTs and folds every line to RFC 5545's 75-octet limit.
//
// events: [{ uid, dtstartDate: 'YYYYMMDD', rrule: 'FREQ=DAILY;INTERVAL=9',
//            summary, description, transparent }]
//   - dtstartDate is an all-day date (DTSTART;VALUE=DATE), never a
//     date-time — these are reminders, not timed events.
//   - transparent defaults to true (TRANSP:TRANSPARENT), matching the
//     source: a "check the soil" reminder shouldn't show as busy time.
// now: Date used for every event's DTSTAMP; defaults to `new Date()`,
//   injectable so callers/tests get a deterministic timestamp.
function buildVCalendar({ prodId, calName, events, now }) {
  const stamp = formatUtcStamp(now || new Date());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:' + prodId, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  if (calName) lines.push('X-WR-CALNAME:' + escapeText(calName));
  (events || []).forEach((ev) => {
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + ev.uid);
    lines.push('DTSTAMP:' + stamp);
    lines.push('DTSTART;VALUE=DATE:' + ev.dtstartDate);
    lines.push('RRULE:' + ev.rrule);
    lines.push('SUMMARY:' + escapeText(ev.summary));
    if (ev.description) lines.push('DESCRIPTION:' + escapeText(ev.description));
    lines.push('TRANSP:' + (ev.transparent === false ? 'OPAQUE' : 'TRANSPARENT'));
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

module.exports = { escapeText, foldLine, formatUtcStamp, buildVCalendar };
