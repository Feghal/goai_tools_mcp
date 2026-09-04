'use strict';

const { clientKey } = require('../middleware/security');

// clientKey() is the express-rate-limit keyGenerator, so whatever it returns
// IS the bucket and IS the MemoryStore key. CF-Connecting-IP is a header any
// caller can set, and the firewall that is meant to make it trustworthy (by
// leaving Cloudflare as the only route to the origin) is the thing that
// actually secures it -- these tests cover the half that is ours: an
// unvalidated header was both an unbounded key and a free bucket.

const req = (header, ip = '10.0.0.9') => ({
  headers: header === undefined ? {} : { 'cf-connecting-ip': header },
  ip,
});

describe('clientKey', () => {
  test('honours a CF-Connecting-IP that is a real address', () => {
    expect(clientKey(req('203.0.113.7'))).toBe('203.0.113.7');
    expect(clientKey(req('2001:db8::1'))).toBe('2001:db8::1');
    expect(clientKey(req('  203.0.113.7  '))).toBe('203.0.113.7');
  });

  test('falls back to req.ip for anything net.isIP() rejects', () => {
    // The bucket a spoofer used to get for free: any string at all was a
    // fresh, unmetered quota. These now all land in the caller's real one.
    for (const junk of ['client-1', 'localhost', '203.0.113.999', '203.0.113.7:443', 'null', '-', '']) {
      expect(clientKey(req(junk))).toBe('10.0.0.9');
    }
  });

  test('never lets the header size the store key', () => {
    // 4 KB of 'A' was accepted verbatim as a MemoryStore key, so a stranger
    // could grow the limiter's own memory a header at a time.
    const key = clientKey(req('A'.repeat(4000)));
    expect(key).toBe('10.0.0.9');
    expect(key.length).toBeLessThan(50);
  });

  test('ignores a repeated header, which Node hands over as an array', () => {
    expect(clientKey(req(['203.0.113.7', '198.51.100.4']))).toBe('10.0.0.9');
  });

  test('falls back when the header is absent', () => {
    expect(clientKey(req(undefined))).toBe('10.0.0.9');
  });
});
