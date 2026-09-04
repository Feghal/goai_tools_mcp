'use strict';

const net = require('net');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// MARK: - Configuration

// Every knob here is read from the environment at call time rather than
// captured once at module load. The operator's whole escape hatch on this
// box is "set one env var, restart" — reading late costs a string compare
// per request and removes a class of bug where a value looks configured but
// the module cached the empty string it was required with.

let originsRaw = null;
let originsList = [];
function allowedOrigins() {
  const raw = process.env.MCP_ALLOWED_ORIGINS || '';
  if (raw !== originsRaw) {
    originsRaw = raw;
    originsList = raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return originsList;
}

// Auth is OPTIONAL. Unset/empty MCP_API_KEY means the service runs fully
// open, which is what this deployment wants: a public MCP endpoint anyone
// can connect to by URL alone. Setting MCP_API_KEY switches the shared
// secret back on for every non-public path, with no other change.
//
// This used to be mandatory-and-broken: an unset key returned 500
// auth_not_configured on every request, so "public mode" did not exist —
// the server was unusable rather than open.
function apiKey() {
  const raw = process.env.MCP_API_KEY;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

// Paths that never require the API key, even when one IS configured.
//
//   GET /              the container HEALTHCHECK curls it every 30s and has
//                      no way to attach a header.
//   GET /files/:token  the entire point of a download link is that a browser
//                      tab or a generic fetch can follow it, and neither
//                      sends a custom header. The capability IS the 128-bit
//                      random token, plus delete-on-download and the TTL
//                      sweep — see utils/outputStore.js.
//
// Only '/' was listed here before, so every large-output tool handed back a
// link that answered 401 while three separate comments claimed otherwise.
// The prefix match (rather than a token-shaped regex) is deliberate: a
// malformed token is filesController's 404 to give, not the auth layer's
// 401 — leaking "that token is well-formed" from the status code is exactly
// the oracle we don't want.
function isPublicPath(req) {
  if (req.method !== 'GET') return false;
  return req.path === '/' || req.path.startsWith('/files/');
}

// The rate limiter skips only the health check. /files/:token is
// unauthenticated but NOT unlimited — public plus unmetered is how a
// stranger turns one leaked link into a bandwidth bill.
function isHealthCheck(req) {
  return req.method === 'GET' && req.path === '/';
}

// MARK: - Helpers

function extractApiKey(req) {
  const h1 = req.headers['x-api-key'];
  if (typeof h1 === 'string' && h1.trim()) return h1.trim();
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+([^\s]+)$/i);
    if (m) return m[1];
  }
  return null;
}

// Who to charge a request to.
//
// The production chain is Cloudflare -> the website's nginx -> this app, so
// what Express sees on the socket is the nginx container's bridge address,
// and X-Forwarded-For arrives as "<real client>, <cloudflare edge>" (nginx
// appends $remote_addr to the header Cloudflare already set). Express's
// `trust proxy` counts hops from the app outward, so trust=1 resolves req.ip
// to the CLOUDFLARE EDGE address — verified by running it — which would put
// every visitor sharing a PoP into one bucket. MCP_TRUST_PROXY_HOPS exists
// so the deployment can say 2 without a code change.
//
// The limiter itself keys on CF-Connecting-IP when present, because that is
// the one header on this path with a single unambiguous meaning: the client
// Cloudflare accepted the connection from.
//
// It is honoured ONLY when net.isIP() accepts it, because a header anyone
// can set is a hint, not an identity. Validating does not stop spoofing —
// a caller that reaches the origin directly can still send a well-formed
// address it does not own, and only the firewall forcing all traffic through
// Cloudflare fixes that. What validating does fix is cheaper and entirely
// ours: an arbitrary string was being used verbatim as a MemoryStore key, so
// a 4 KB header was a 4 KB key and any junk value was a free, unmetered
// bucket. Rejecting non-IPs bounds the key and makes the header useless for
// buying a fresh quota — a spoofer now has to at least look like a client.
function clientKey(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && net.isIP(cf.trim())) return cf.trim();
  return req.ip;
}

// MARK: - Auth guard
//
// One shared secret when enabled — no OAuth, no per-user accounts. For a
// public, unauthenticated tool host that is the whole story; if this ever
// needs per-caller identity or quotas, the MCP Authorization spec's OAuth
// 2.1 flow is the thing to reach for, and this deliberately isn't it.

function authGuard(req, res, next) {
  const expected = apiKey();
  if (!expected) return next(); // public mode — announced once at boot below
  if (isPublicPath(req)) return next();

  const provided = extractApiKey(req);
  if (!provided || provided !== expected) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

// MARK: - Apply all layers

/**
 * Apply the security middleware stack to an Express app.
 *
 * Every default comes from the environment so the box can be retuned with a
 * restart; the options argument is for tests that want to pin a value.
 *
 * @param {import('express').Application} app
 * @param {Object} [options]
 * @param {number}  [options.rateLimitMax]        Max requests per window per client
 * @param {number}  [options.rateLimitWindowMs]   Window size in ms
 * @param {boolean} [options.enableRateLimit=true] Set false to skip rate limiting
 */
function applySecurity(app, options = {}) {
  const {
    // Deliberately very high. The throttle that protects this 1 GB / 1 vCPU
    // box is not requests-per-minute — it is bytes-and-seconds per call
    // (MAX_INPUT_BYTES, the per-tool bounds, and the 125s edge timeout that
    // kills anything slower). A generous ceiling here still stops a trivial
    // flood from pinning the single shared vCPU, which is the only job it
    // has. Tune with MCP_RATE_LIMIT_MAX / MCP_RATE_LIMIT_WINDOW_MS.
    rateLimitMax = Number(process.env.MCP_RATE_LIMIT_MAX) || 1200,
    rateLimitWindowMs = Number(process.env.MCP_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
    enableRateLimit = true,
  } = options;

  // Hops between this app and the real client (see clientKey above): 1 for
  // the dev compose's single nginx sidecar, 2 for the production
  // Cloudflare -> website-nginx chain.
  const trustProxyHops = Number(process.env.MCP_TRUST_PROXY_HOPS) || 1;
  app.set('trust proxy', trustProxyHops);

  // Layer 1: security headers.
  //
  // This service is published as a PATH on goaichat.app, not a subdomain, so
  // every header below lands on the same ORIGIN as the website. Helmet's
  // defaults are written for a service that owns its origin; here they are a
  // policy change to a site this service is documented as not touching, and
  // browsers apply the origin's policy from whichever response set it last.
  // So anything origin-scoped and meaningless for a JSON-RPC API is turned
  // off, and the API-relevant per-response headers (nosniff, referrer
  // policy, the X-* legacies) are kept. The website's nginx also strips
  // these with proxy_hide_header, but that is the backstop — a second layer
  // that cannot be the primary fix, because it only guards the one route
  // this app happens to be published on today.
  app.use(helmet({
    // The dangerous one, and the reason this block exists. HSTS is stored
    // per REGISTRABLE DOMAIN, not per path: one response carrying
    // includeSubDomains pins goaichat.app AND every subdomain to HTTPS for a
    // year in that browser, and removing the header later does not unpin it.
    // GET /files/:token exists precisely so a browser follows it, so this
    // was not theoretical. The apex has never sent HSTS; a service on a
    // sub-path does not get to decide that it now does.
    strictTransportSecurity: false,

    // A JSON-RPC endpoint renders no documents, so a CSP here protects
    // nothing — but it is origin-scoped like the rest, and helmet's default
    // (default-src 'self'; script-src 'self'; upgrade-insecure-requests) is
    // nothing like the website's own policy.
    contentSecurityPolicy: false,

    // Same class: framing and cross-origin-isolation policies for an API
    // with no HTML. COOP additionally severs window.opener relationships,
    // which is a browsing-context decision that belongs to the site.
    crossOriginOpenerPolicy: false,
    xFrameOptions: false,
    originAgentCluster: false,

    // Kept, and deliberately not default: same-origin CORP would block a
    // browser MCP client (or a plain <img src>) from reading a
    // /files/:token download it is entitled to. This service is a public API
    // with no cookies and no same-origin secrets, so there is nothing for
    // CORP to protect here.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  // Layer 2: CORS.
  //
  // Empty MCP_ALLOWED_ORIGINS means "any origin", not "no origin": this is a
  // public server and browser-based MCP clients are legitimate callers. It
  // used to mean neither — the callback threw for every request carrying an
  // Origin header and server.js's catch-all turned that into a 500.
  // Setting the list still restricts to exactly those origins, and a
  // rejected one now carries err.status = 403 so it reads as the policy
  // decision it is.
  app.use(cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true); // server-to-server, no Origin header
      const list = allowedOrigins();
      if (list.length === 0) return callback(null, true);
      if (list.includes(origin)) return callback(null, true);
      const err = new Error('origin_not_allowed');
      err.status = 403;
      return callback(err);
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    // What the Streamable HTTP client actually sends. Listing them means the
    // preflight answers with exactly these rather than reflecting whatever
    // was asked for.
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'Authorization',
      'x-api-key',
      'x-user-id',
      'Mcp-Session-Id',
      'MCP-Protocol-Version',
      'Last-Event-ID',
    ],
    // Response headers a browser client cannot read unless we say so.
    // Mcp-Session-Id and MCP-Protocol-Version are how the SDK negotiates;
    // without these two exposed a browser client is functionally blind even
    // though the request succeeded.
    exposedHeaders: ['Mcp-Session-Id', 'MCP-Protocol-Version', 'WWW-Authenticate'],
    // No cookies, no credentials — the API key, when there is one, is a
    // plain header. Keeping credentials off is what lets origin be '*'-ish.
    credentials: false,
    maxAge: 600,
  }));

  // Layer 3: rate limiting.
  if (enableRateLimit) {
    app.use(rateLimit({
      windowMs: rateLimitWindowMs,
      max: rateLimitMax,
      standardHeaders: true,
      legacyHeaders: false,
      skip: isHealthCheck,
      keyGenerator: clientKey,
      handler: (_req, res) => {
        res.status(429).json({
          ok: false,
          error: 'rate_limit_exceeded',
          retry_after: Math.ceil(rateLimitWindowMs / 1000),
        });
      },
    }));
  }

  // Layer 4: auth guard — a no-op in public mode.
  app.use(authGuard);

  // Say it once, at boot, in the log the operator actually reads. An
  // unauthenticated public endpoint is a deliberate choice here, but it is
  // not a thing anyone should ever discover by accident.
  if (apiKey()) {
    console.log('auth: ENABLED — /mcp requires x-api-key or Authorization: Bearer (GET / and GET /files/:token stay public)');
  } else {
    console.warn('auth: DISABLED — MCP_API_KEY is unset, so this server is FULLY PUBLIC and anyone who knows the URL can call every tool. Set MCP_API_KEY and restart to require a shared secret.');
  }
  if (allowedOrigins().length === 0) {
    console.log('cors: any origin allowed (MCP_ALLOWED_ORIGINS is empty)');
  } else {
    console.log(`cors: restricted to ${allowedOrigins().join(', ')}`);
  }
  console.log(`rate limit: ${rateLimitMax} requests / ${Math.ceil(rateLimitWindowMs / 1000)}s per client, trust proxy hops=${trustProxyHops}`);
}

module.exports = {
  applySecurity,
  extractApiKey,
  isPublicPath,
  isHealthCheck,
  clientKey,
};
