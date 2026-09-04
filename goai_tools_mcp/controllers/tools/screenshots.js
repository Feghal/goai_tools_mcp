'use strict';

const { z } = require('zod');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const toolResult = require('../../utils/toolResult');
const byteLimits = require('../../utils/byteLimits');
const outputStore = require('../../utils/outputStore');
const { zip } = require('../../utils/zip');
const { FONTS, fontByName } = require('../../utils/fonts');

// A faithful server-side port of tools/screenshots.html's pure RENDER path
// (plan/fitGroup/wrap/drawDevice/drawText/paintSlide). Everything in that
// file about selection, dragging, undo, the on-canvas editor and the
// properties panel is UI state with no analogue in a one-shot declarative
// call, and is not ported — the caller sends the finished composition
// directly instead of building it gesture by gesture. `base`, the CSS
// first-baseline metric the browser needs to align a DOM textarea overlay
// over canvas-drawn text, also has no analogue here (no overlay exists),
// so this only measures asc/desc, the ink-box metrics the drawing math
// actually needs.

const SIZES = {
  '6.9': ['6.9" iPhone', 1320, 2868],
  '6.7': ['6.7" iPhone', 1290, 2796],
  '6.5': ['6.5" iPhone', 1242, 2688],
  '13ipad': ['13" iPad', 2064, 2752],
};
const FONT_NAMES = FONTS.map((f) => f.n);

const BETA = 0.026;
const PADX = 0.08, TOPPAD = 0.055, GAPUNDER = 0.028, EDGEPAD = 0.05;
const FS0 = 0.072, FSMIN = 0.038, LINEH = 1.16, MAXLINES = 3;
const SNAP = 0.96;
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

// ---- resource limits -----------------------------------------------------
// This service is co-hosted with the public website on a 1 GB box and its
// container is capped at 400 MB. Measured on the real image at
// `--memory 400m`, idle (31 tools + 22 fonts) is ~40 MB of anonymous memory,
// so one in-flight call gets ~360 MB — and utils/heavyGate.js is what makes
// "one in-flight call" true, by refusing a second heavy call rather than
// letting two of these run at once (two concurrent worst-case calls were
// measured at exit 137, OOMKilled). The whole call also has to finish inside
// Cloudflare's non-raisable 125 s proxy read timeout. Every bound below is
// derived from one of those two ceilings, and each one carries its own
// arithmetic. They are all checked BEFORE any rendering starts and phrased
// so the caller is told how to split the work, rather than the call running
// for two minutes and then being killed.
const LIMITS = {
  // Input bytes are NOT this tool's to choose: utils/byteLimits.js already
  // sizes them against the same 400 MB container (4 MB per file, 4 MB
  // aggregate, and server.js derives Express's 6 MB JSON body limit from
  // the same constant). Deferring to it rather than declaring a parallel
  // number is the only way the two cannot drift — a bigger number here
  // would just turn into an opaque 413 from the framework.
  MAX_PAGES: 10,
  MAX_IMAGE_BYTES: byteLimits.MAX_INPUT_BYTES,             // per page, decoded from base64
  MAX_TOTAL_IMAGE_BYTES: byteLimits.MAX_TOTAL_INPUT_BYTES, // summed over every page in the call

  // Decoded pixels, which the byte cap says nothing about: PNG is lossless
  // but a flat UI screenshot still compresses ~15:1. 6 MP admits every
  // native App Store source (the largest, 13" iPad at 2064x2752, is
  // 5.68 MP) and costs 24 MB of RGBA — the same per-bitmap figure
  // byteLimits.js budgets for.
  MAX_IMAGE_PIXELS: 6000000,
  // A device may spill onto neighbouring pages, and every slide it touches
  // has to hold that page's bitmap while it paints, so one slide can need
  // more than one at a time. 96 MB is four max-size bitmaps.
  MAX_LIVE_IMAGE_BYTES: 96000000,
  // utils/zip.js takes every entry as a Buffer up front and Buffer.concat's
  // them, so the PNGs cost 2x their total at archive time.
  //
  // This used to be 32 MB, which MAX_PAGES could not actually reach: ten
  // pages of real screenshots at 6.9" produce ~35 MB, so the advertised page
  // count was unusable at the larger sizes and the caller paid the full
  // render (measured 15.4 s in the container) before being told. The number
  // is now measured rather than modelled. The densest call the input bounds
  // admit — ten pages at 13" iPad, each source as detailed as the 4 MB
  // aggregate input cap allows — produces 91.8 MB of PNG and peaks at
  // 219 MB of container anon memory, buffers plus ZIP concat included. 100 MB
  // covers that with room, and 2x100 MB against a ~360 MB single-call
  // allowance leaves the margin the ZIP concat needs.
  MAX_TOTAL_OUTPUT_BYTES: 100000000,

  // Wall clock. One render is one full-canvas paint plus a PNG encode; on
  // one shared vCPU that is seconds, not milliseconds, and `size:"all"`
  // multiplies it by four.
  MAX_RENDERS_PER_CALL: 12,          // pages x sizes

  // CPU. fitGroup() re-wraps every member of a fit group up to 24 times,
  // per size, so text volume is a quadratic-ish cost with no natural cap.
  MAX_TEXTS: 40,
  MAX_TEXT_CHARS: byteLimits.MAX_SHORT_TEXT_CHARS,

  // Geometry. Offset and scale are what decide how far a device spills, and
  // therefore how many bitmaps one slide can need at once. Measured with
  // plan(): at these bounds the worst composition puts 5 devices on one
  // slide, which MAX_LIVE_IMAGE_BYTES then refuses if they are all
  // full-size. Unbounded, one device could reach every page in the set.
  MAX_OFFSET: 1,
  MIN_DEVICE_SCALE: 0.05,
  MAX_DEVICE_SCALE: 1.5,
  MAX_ROTATION_DEG: 90,
};

// Worst-case PNG output a call produces, in bytes per megapixel of canvas
// SUMMED over all its slides, indexed by page count (index 0 unused).
//
// Measured, not modelled: for each page count the sources were made as
// detailed as MAX_TOTAL_INPUT_BYTES allows at that count (random noise
// re-encoded to fill 4 MB / pages) and the largest size, 13" iPad, was
// rendered at the maximum device scale. That is the densest legal input.
//
// Why it is a curve rather than one constant: a call's total input is capped
// at 4 MB however many pages it has, so pages SHARE that detail budget. One
// page can carry a nearly incompressible 4 MB source and cost 3.06 MB of PNG
// per megapixel of canvas; ten pages splitting the same 4 MB are much
// smoother and cost 1.62 each, 16.16 for the set. A single per-pixel
// constant is therefore either far too high at ten pages (refusing calls
// that fit) or far too low at one (never refusing anything).
//
// Deliberately the measured value with no safety margin added. Over-
// estimating refuses a legal call, which is the bug this replaced;
// under-estimating only defers to the running byte check further down, which
// is exact.
const WORST_OUTPUT_BYTES_PER_MEGAPIXEL = [
  0, 3.06e6, 5.88e6, 8.56e6, 11.04e6, 13.38e6, 14.82e6, 15.34e6, 15.97e6, 16.02e6, 16.16e6,
];

function canvasMegapixels(sizeKeys) {
  return sizeKeys.reduce((sum, k) => sum + (SIZES[k][1] * SIZES[k][2]) / 1e6, 0);
}

// What `pages` pages at `sizeKeys` can cost at worst, before anything is
// decoded or drawn. Page counts past the table (unreachable through the
// schema) fall back to its last entry.
function estimateOutputBytes(pages, sizeKeys) {
  const perMp = WORST_OUTPUT_BYTES_PER_MEGAPIXEL[Math.min(pages, WORST_OUTPUT_BYTES_PER_MEGAPIXEL.length - 1)];
  return Math.round(perMp * canvasMegapixels(sizeKeys));
}

// The page count that actually fits, for a given set of sizes — the honest
// version of MAX_PAGES, which is only the ceiling. Every single size reaches
// the full 10; size:"all" renders every canvas four times over and reaches 2.
// Also used in the error advice and in the tool description, so the number a
// caller is told is the number the check enforces.
function maxPagesFor(sizeKeys) {
  let best = 0;
  for (let p = 1; p <= LIMITS.MAX_PAGES; p++) {
    if (p * sizeKeys.length > LIMITS.MAX_RENDERS_PER_CALL) break;
    if (estimateOutputBytes(p, sizeKeys) > LIMITS.MAX_TOTAL_OUTPUT_BYTES) break;
    best = p;
  }
  return best;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// A 1x1 PNG. Assigning it to a decoded Image's `src` is the only way to
// hand @napi-rs/canvas's native side back the RGBA bitmap: dropping the JS
// reference does not — measured, ten dropped 1290x2796 images still cost
// 174 MB, the same ten released this way cost 6 MB.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdC' +
  'AK7OHOkAAAALSURBVAiZY2AAAgAABQABYlUyiAAAAABJRU5ErkJggg==',
  'base64'
);
function releaseImage(img) {
  if (!img) return;
  try { img.src = TINY_PNG; } catch (e) { /* already gone; nothing to reclaim */ }
}
// Same problem one level up: a Canvas keeps its surface AND a reference to
// every distinct image ever drawn onto it, so a canvas that is merely
// dropped keeps ~15 MB plus every bitmap it composited. Resizing to 1x1
// throws the surface away immediately.
function releaseCanvas(cv) {
  if (!cv) return;
  try { cv.width = 1; cv.height = 1; } catch (e) { /* ditto */ }
}

// ---- font metrics + text measurement, cached per render call -------------
const probe = createCanvas(10, 10).getContext('2d');
function measureFontMetrics(f) {
  probe.font = f.weight + ' 100px "' + f.family + '"';
  const m = probe.measureText('Hxg');
  return {
    asc: (m.actualBoundingBoxAscent || 78) / 100,
    desc: (m.actualBoundingBoxDescent || 22) / 100,
  };
}
const metricsCache = new Map();
function metricsOf(ff) {
  if (!metricsCache.has(ff)) metricsCache.set(ff, measureFontMetrics(ff));
  return metricsCache.get(ff);
}

function makeWidthCache() {
  const cache = new Map();
  let lastFont = '';
  return function width100(text, ff) {
    const key = ff.family + '|' + text;
    if (cache.has(key)) return cache.get(key);
    const fontStr = ff.weight + ' 100px "' + ff.family + '"';
    if (fontStr !== lastFont) { probe.font = fontStr; lastFont = fontStr; }
    const w = probe.measureText(text).width;
    cache.set(key, w);
    return w;
  };
}

function wrap(text, maxW, fs, ff, width100) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  function w(s) { return (width100(s, ff) * fs) / 100; }
  words.forEach((word) => {
    while (w(word) > maxW && word.length > 1) {
      let cut = word.length;
      while (cut > 1 && w(word.slice(0, cut)) > maxW) cut--;
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const probeLine = line ? line + ' ' + word : word;
    if (w(probeLine) > maxW && line) { lines.push(line); line = word; }
    else line = probeLine;
  });
  if (line) lines.push(line);
  return lines;
}
function wrapAll(text, maxW, fs, ff, width100) {
  const parts = String(text).split('\n');
  const out = [];
  parts.forEach((part) => {
    const ls = wrap(part, maxW, fs, ff, width100);
    if (!ls.length) out.push('');
    else out.push(...ls);
  });
  return out;
}

function fitGroup(members, W, width100) {
  let fs = FS0 * W;
  let guard = 0;
  while (guard++ < 24) {
    let deepest = 0, worst = 0;
    members.forEach((t) => {
      const mw = t.w * W;
      const ls = t.s ? wrapAll(t.s, mw, fs, t.ff, width100) : [];
      if (ls.length > deepest) deepest = ls.length;
      ls.forEach((l) => {
        const r = mw > 0 ? (width100(l, t.ff) * fs) / 100 / mw : 0;
        if (r > worst) worst = r;
      });
    });
    if ((deepest <= MAXLINES && worst <= 1) || fs <= FSMIN * W) break;
    fs = Math.max(FSMIN * W, fs * Math.min(0.92, worst > 0 ? 1 / worst : 0.92));
  }
  return fs;
}

// ---- plan(): everything the whole set needs, computed once ---------------
// `pages` entries carry geometry only — { device } — never pixels. That is
// what makes the streaming render possible: the full layout, including
// which slides each device spills onto, is known before a single input
// image has been decoded.
function plan(W, H, pages, texts, joinedScene, width100) {
  const n = pages.length;
  const k = H / W;

  const groups = Object.create(null);
  const sizes = Object.create(null);
  texts.forEach((t) => {
    if (!t.auto) { sizes[t.id] = FS0 * W * t.fsq; return; }
    const key = t.fg || ('#' + t.id);
    (groups[key] || (groups[key] = [])).push(t);
  });
  Object.keys(groups).forEach((key) => {
    const fs = fitGroup(groups[key], W, width100);
    groups[key].forEach((t) => { sizes[t.id] = fs; });
  });

  const baseFont = fontByName(FONT_NAMES[0]);
  const baseAsc = metricsOf(baseFont).asc;
  const baseY = TOPPAD * H + baseAsc * FS0 * W;

  const textRecs = texts.map((t) => {
    const fs = sizes[t.id];
    return {
      o: t,
      sl: t.sl,
      fs,
      ls: t.s ? wrapAll(t.s, t.w * W, fs, t.ff, width100) : [],
      cx: t.sl * W + W / 2 + t.dx * W,
      by: baseY + t.dy * H,
    };
  });

  const refTextH = TOPPAD * H + LINEH * FS0 * W;
  const bandY = refTextH + GAPUNDER * H;
  const bandH = Math.max(0.25 * H, H - bandY - EDGEPAD * H);

  const cap = 0.86;
  const sw0 = Math.min((cap * W) / (1 + 2 * BETA), bandH / (k + 2 * BETA));
  const acy = bandY + bandH / 2;

  const devices = [];
  for (let j = 0; j < n; j++) {
    const page = pages[j];
    if (!page || !page.device) continue;
    const o = page.device;
    const acx = j * W + W / 2;
    const dsw = sw0 * o.s;
    const db = Math.max(6, BETA * dsw);
    const dsh = dsw * k;
    devices.push({
      j,
      acx, acy, cx: acx + o.dx * W, cy: acy + o.dy * H,
      s: o.s, rot: o.rot, sw: dsw, sh: dsh, b: db,
      bw: dsw + 2 * db, bh: dsh + 2 * db,
      hw: ((dsw + 2 * db) * Math.abs(Math.cos(o.rot)) + (dsh + 2 * db) * Math.abs(Math.sin(o.rot))) / 2,
      hh: ((dsw + 2 * db) * Math.abs(Math.sin(o.rot)) + (dsh + 2 * db) * Math.abs(Math.cos(o.rot))) / 2,
    });
  }

  return { n, W, H, k, texts: textRecs, devices, bandY, bandH, baseY, joined: joinedScene && n > 1 };
}

// The one definition of "this device is visible on that slide". Used both
// to paint and, ahead of painting, to decide which input images have to be
// decoded for a given slide — the two must never drift apart.
function overlapsSlide(d, i, W) {
  return d.cx + d.hw > i * W && d.cx - d.hw < (i + 1) * W;
}

function fit(d, sh) {
  if (!sh || !sh.w || !sh.h) return { dw: 0, dh: 0 };
  const cover = Math.max(d.sw / sh.w, d.sh / sh.h);
  const contain = Math.min(d.sw / sh.w, d.sh / sh.h);
  let base = contain >= SNAP * cover ? cover : contain;
  if (Math.abs(contain / cover - 1) < 1e-6) base = cover;
  return { dw: sh.w * base, dh: sh.h * base };
}

function rounded(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawDevice(ctx, p, d, shot) {
  const phone = p.k > 1.8;
  const rs = d.sw * (phone ? 0.135 : 0.032);
  const m = fit(d, shot);
  ctx.save();
  ctx.translate(d.cx, d.cy);
  if (d.rot) ctx.rotate(-d.rot);
  const bx = -d.bw / 2, by = -d.bh / 2, sx = -d.sw / 2, sy = -d.sh / 2;

  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = d.bw * 0.07;
  ctx.shadowOffsetY = d.bw * 0.02;
  ctx.fillStyle = '#0b0b0d';
  rounded(ctx, bx, by, d.bw, d.bh, rs + d.b);
  ctx.fill();
  ctx.shadowColor = 'transparent';

  ctx.save();
  rounded(ctx, sx, sy, d.sw, d.sh, rs);
  ctx.clip();
  if (shot && shot.img) {
    ctx.fillStyle = shot.pad || '#17171c';
    ctx.fillRect(sx, sy, d.sw, d.sh);
    ctx.drawImage(shot.img, sx + (d.sw - m.dw) / 2, sy + (d.sh - m.dh) / 2, m.dw, m.dh);
  } else {
    ctx.fillStyle = '#17171c';
    ctx.fillRect(sx, sy, d.sw, d.sh);
  }
  if (phone) {
    const isl = d.sw * 0.3, islH = d.sw * 0.085;
    ctx.fillStyle = '#000';
    rounded(ctx, -isl / 2, sy + d.sw * 0.028, isl, islH, islH / 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.restore();
}

function drawText(ctx, rec) {
  const o = rec.o, f = fontByName(o.ffName);
  ctx.save();
  if (o.rot) {
    ctx.translate(rec.cx, rec.by);
    ctx.rotate(o.rot);
    ctx.translate(-rec.cx, -rec.by);
  }
  ctx.fillStyle = o.col;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.direction = RTL.test(o.s) ? 'rtl' : 'ltr';
  ctx.font = f.weight + ' ' + rec.fs + 'px "' + f.family + '"';
  rec.ls.forEach((line, r) => {
    ctx.fillText(line, rec.cx, rec.by + r * LINEH * rec.fs);
  });
  ctx.restore();
}

// `shots` is a Map<pageIndex, {img,pad,w,h}> holding ONLY the images this
// slide needs; it is emptied and released by the caller as soon as the
// slide has been encoded.
function paintSlide(cv, W, H, p, i, shots, c1, c2) {
  const ctx = cv.getContext('2d');
  ctx.save();
  ctx.translate(-i * W, 0);

  const g = p.joined
    ? ctx.createLinearGradient(0, 0, p.n * W, H)
    : ctx.createLinearGradient(i * W, 0, i * W, H);
  g.addColorStop(0, c1);
  g.addColorStop(1, c2);
  ctx.fillStyle = g;
  ctx.fillRect(i * W, 0, W, H);

  p.devices.forEach((d) => {
    if (overlapsSlide(d, i, W)) drawDevice(ctx, p, d, shots.get(d.j) || null);
  });
  p.texts.forEach((rec) => {
    if (rec.sl !== i || !rec.ls.length) return;
    drawText(ctx, rec);
  });
  ctx.restore();
}

// the average colour, so a letterboxed shot sits on something related to it
function padColour(img) {
  try {
    const c = createCanvas(4, 4);
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, 4, 4);
    const d = x.getImageData(0, 0, 4, 4).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    const colour = 'rgb(' + Math.round(r / n) + ',' + Math.round(g / n) + ',' + Math.round(b / n) + ')';
    releaseCanvas(c);
    return colour;
  } catch (e) {
    return '#17171c';
  }
}

// One shape for every "you asked for more than this box can do" message:
// what was measured, what it measured, what the ceiling is, and — the part
// that matters to an agent caller — how to split the work so it fits.
function tooLarge(what, actual, limit, unit, advice) {
  return new Error(
    `render_app_store_screenshot limit exceeded: ${what} = ${actual} ${unit}, limit ${limit} ${unit}. ${advice}`
  );
}

// ---- one JSON description -> N PNGs ---------------------------------------
// Structured so that at any instant the process holds exactly one output
// canvas and only the input bitmaps the slide being painted actually needs
// (one, unless a device spills across pages). Both are released explicitly
// rather than left to the GC, which does not see native Skia allocations
// and will happily let ten of them pile up.
async function renderScreenshots(input) {
  const width100 = makeWidthCache();

  const pageList = input.pages || [];
  if (!pageList.length) throw new Error('pages must contain at least 1 entry');
  if (pageList.length > LIMITS.MAX_PAGES) {
    throw tooLarge('pages', pageList.length, LIMITS.MAX_PAGES, 'entries',
      'Split the set across several calls.');
  }

  const textList = input.texts || [];
  if (textList.length > LIMITS.MAX_TEXTS) {
    throw tooLarge('texts', textList.length, LIMITS.MAX_TEXTS, 'entries',
      'Merge captions that share a page into one multi-line text ("\\n" forces a break).');
  }
  textList.forEach((t, idx) => {
    const len = String(t.text || '').length;
    if (len > LIMITS.MAX_TEXT_CHARS) {
      throw tooLarge(`texts[${idx}].text`, len, LIMITS.MAX_TEXT_CHARS, 'characters',
        'App Store screenshot captions are headlines, not paragraphs; shorten it.');
    }
  });

  const sizeKeys = input.size === 'all' ? Object.keys(SIZES) : [input.size];
  const renders = pageList.length * sizeKeys.length;
  if (renders > LIMITS.MAX_RENDERS_PER_CALL) {
    throw new Error(
      `this call would render ${renders} PNGs (${pageList.length} pages x ${sizeKeys.length} sizes), ` +
      `over the ${LIMITS.MAX_RENDERS_PER_CALL} render limit for render_app_store_screenshot. ` +
      (sizeKeys.length > 1
        ? `Make one call per size instead of size:"all" — a single-size call may carry all ` +
          `${Math.min(pageList.length, LIMITS.MAX_PAGES)} pages — or keep size:"all" and send at most ` +
          `${maxPagesFor(sizeKeys)} pages per call.`
        : `Split the pages across several calls of at most ${LIMITS.MAX_RENDERS_PER_CALL} each.`)
    );
  }

  // The output-byte budget, checked from page count x canvas size alone —
  // no decoding, no drawing, microseconds. The exact running check further
  // down cannot be the only one: it is reached one PNG at a time, so a call
  // that cannot possibly fit still pays the whole render first (measured
  // 15.4 s in the container for ten pages) before being refused.
  const estimated = estimateOutputBytes(pageList.length, sizeKeys);
  if (estimated > LIMITS.MAX_TOTAL_OUTPUT_BYTES) {
    const fits = maxPagesFor(sizeKeys);
    throw tooLarge(
      `the PNGs ${pageList.length} pages at ${sizeKeys.length > 1 ? `all ${sizeKeys.length} sizes` : SIZES[sizeKeys[0]][0]} can produce`,
      estimated, LIMITS.MAX_TOTAL_OUTPUT_BYTES, 'bytes',
      `The ZIP writer needs every PNG in memory at once, so this is refused before rendering rather than after. ` +
      (fits > 0
        ? `Send at most ${fits} page${fits === 1 ? '' : 's'} per call at ${sizeKeys.length > 1 ? 'size:"all"' : 'this size'}` +
          (sizeKeys.length > 1 ? `, or make one call per size — a single-size call carries all ${LIMITS.MAX_PAGES} pages.` : '.')
        : 'Use a smaller size.')
    );
  }

  // ---- pass 1: decode the base64 for every page in one batch, so the
  // aggregate is rejected from the string lengths before a single Buffer is
  // allocated, then validate the images ONE decoded bitmap at a time.
  // Nothing pixel-shaped survives this loop: each image is measured, its
  // letterbox colour taken, and the bitmap handed straight back.
  const withImages = [];
  pageList.forEach((p, j) => { if (p && p.imageBase64) withImages.push({ j, b64: p.imageBase64 }); });

  let bufs;
  try {
    bufs = byteLimits.decodeBatch(withImages, (e) => e.b64, {
      perFileLimit: LIMITS.MAX_IMAGE_BYTES,
      totalLimit: LIMITS.MAX_TOTAL_IMAGE_BYTES,
    });
  } catch (e) {
    if (e && e.name === 'InputTooLargeError') {
      throw tooLarge('the page screenshots in this call', e.actualBytes, e.limitBytes, 'bytes',
        'Send fewer pages per call, or re-encode the screenshots smaller — JPEG at quality 80 is ' +
        'typically a quarter the size of the equivalent PNG and looks identical inside a device frame.');
    }
    throw e;
  }

  const pageRecs = pageList.map(() => ({ src: null, device: null }));
  for (let n = 0; n < withImages.length; n++) {
    const j = withImages[n].j;
    const buf = bufs[n];

    let img;
    try {
      img = await loadImage(buf);
    } catch (e) {
      throw new Error(`pages[${j}].imageBase64 is not a decodable image: ${e.message}`);
    }
    const w = img.width, h = img.height;
    try {
      // loadImage() has no ceiling of its own — it allocates whatever the
      // container's header declares — so the pixel budget is checked here,
      // with the bitmap already released on the failing path.
      byteLimits.assertPixelBudget(w, h, `render_app_store_screenshot pages[${j}].imageBase64`, LIMITS.MAX_IMAGE_PIXELS);
    } catch (e) {
      releaseImage(img);
      throw e;
    }
    const pad = padColour(img);
    releaseImage(img);

    const p = pageList[j];
    pageRecs[j] = {
      src: { buf, w, h, pad },
      device: {
        dx: p.device?.dx ?? 0,
        dy: p.device?.dy ?? 0,
        s: p.device?.scale ?? 1,
        rot: ((p.device?.rotationDeg ?? 0) * Math.PI) / 180,
      },
    };
  }

  const texts = textList.map((t, idx) => ({
    id: idx + 1,
    sl: t.page,
    s: t.text,
    dx: t.dx,
    dy: t.dy,
    w: t.width,
    fsq: t.fontSizeScale,
    rot: (t.rotationDeg * Math.PI) / 180,
    auto: t.autoFit,
    fg: t.fitGroup || null,
    col: t.color,
    ff: fontByName(t.fontFamily),
    ffName: t.fontFamily,
  }));
  // fitGroup() keys texts by `t.ff`(the metrics object) via width100, but
  // groups by `t.fg` — a distinct, unrelated key. No change needed here;
  // `ff` is threaded through as the resolved font object for width100/draw.

  const outputs = [];
  let totalOutputBytes = 0;

  for (const key of sizeKeys) {
    const [label, W, H] = SIZES[key];
    const p = plan(W, H, pageRecs, texts, input.joinedScene, width100);

    // A device that spills across pages is painted onto every slide it
    // touches, so that slide needs that page's bitmap decoded. Check the
    // worst slide before painting anything: this is the one composition
    // that can hold more than one bitmap at a time, and it is cheaper to
    // refuse it now than to be OOM-killed halfway through.
    for (let i = 0; i < p.n; i++) {
      let live = 0;
      p.devices.forEach((d) => {
        if (!overlapsSlide(d, i, W)) return;
        const src = pageRecs[d.j].src;
        if (src) live += src.w * src.h * 4;
      });
      if (live > LIMITS.MAX_LIVE_IMAGE_BYTES) {
        throw new Error(
          `page ${i + 1} at the ${label} size has enough devices spilling onto it that painting it needs ` +
          `${Math.round(live / 1e6)} MB of decoded screenshots at once, over the ` +
          `${Math.round(LIMITS.MAX_LIVE_IMAGE_BYTES / 1e6)} MB limit for render_app_store_screenshot. ` +
          'Reduce device.scale or device.dx so fewer devices reach the same page, or split the set across calls.'
        );
      }
    }

    const buffers = [];
    for (let i = 0; i < p.n; i++) {
      // A fresh canvas per slide, released at the end of the slide. A
      // reused canvas would be cheaper to allocate but retains a reference
      // to every distinct image ever drawn onto it — measured, 10 slides
      // on one reused canvas cost 164 MB against 121 MB for 10 fresh ones.
      const cv = createCanvas(W, H);
      const shots = new Map();
      try {
        for (const d of p.devices) {
          if (!overlapsSlide(d, i, W) || shots.has(d.j)) continue;
          const src = pageRecs[d.j].src;
          if (!src) continue;
          shots.set(d.j, { img: await loadImage(src.buf), pad: src.pad, w: src.w, h: src.h });
        }
        paintSlide(cv, W, H, p, i, shots, input.backgroundFrom, input.backgroundTo);
        // toBuffer is the flush: @napi-rs/canvas records draw calls and
        // rasterizes here, so the bitmaps must still be alive at this point
        // and may only be released afterwards.
        const png = cv.toBuffer('image/png');
        totalOutputBytes += png.length;
        if (totalOutputBytes > LIMITS.MAX_TOTAL_OUTPUT_BYTES) {
          // The exact backstop behind the pre-render estimate: reachable only
          // by content denser than any input measured, since the estimate is
          // the measured worst case for this page count and canvas size.
          throw tooLarge('the PNGs this call produces', totalOutputBytes, LIMITS.MAX_TOTAL_OUTPUT_BYTES, 'bytes',
            'The ZIP writer needs every PNG in memory at once. These screenshots compress worse than any this ' +
            'tool was measured against — send fewer pages, or a less detailed screenshot.');
        }
        buffers.push(png);
      } finally {
        shots.forEach((s) => releaseImage(s.img));
        shots.clear();
        releaseCanvas(cv);
      }
    }
    outputs.push({ key, label, width: W, height: H, buffers });
  }

  return outputs;
}

// Quoted in three schema strings below; computed rather than written down so
// the number a caller is told cannot drift from the check that enforces it.
const ALL_SIZES_MAX_PAGES = maxPagesFor(Object.keys(SIZES));

const inputShape = {
  pages: z
    .array(
      z
        .object({
          imageBase64: z.string().optional().describe(`Base64 screenshot bytes for this page: at most ${LIMITS.MAX_IMAGE_PIXELS / 1e6} megapixels (13" iPad native, 2064x2752, is 5.68 MP), and at most ${LIMITS.MAX_TOTAL_IMAGE_BYTES / 1e6} MB of decoded bytes SUMMED over every page in the call (the whole JSON body is capped at ${Math.ceil((LIMITS.MAX_TOTAL_IMAGE_BYTES * 1.4) / 1e6)} MB). For a multi-page set send JPEG, not PNG — quality 80 is typically a quarter the size and indistinguishable once scaled into a device frame. Omit for a blank page (title card / outro / continuation of a device from the previous page).`),
          device: z
            .object({
              dx: z.number().min(-LIMITS.MAX_OFFSET).max(LIMITS.MAX_OFFSET).default(0).describe(`Horizontal offset from the device band centre, as a fraction of the canvas width. Positive = right. Limited to +/-${LIMITS.MAX_OFFSET}.`),
              dy: z.number().min(-LIMITS.MAX_OFFSET).max(LIMITS.MAX_OFFSET).default(0).describe(`Vertical offset from the device band centre, as a fraction of the canvas height. Positive = down. Limited to +/-${LIMITS.MAX_OFFSET}.`),
              scale: z.number().min(LIMITS.MIN_DEVICE_SCALE).max(LIMITS.MAX_DEVICE_SCALE).default(1).describe(`Device size multiplier; 1 = the default size that fits the band. Limited to ${LIMITS.MIN_DEVICE_SCALE}-${LIMITS.MAX_DEVICE_SCALE}.`),
              rotationDeg: z.number().min(-LIMITS.MAX_ROTATION_DEG).max(LIMITS.MAX_ROTATION_DEG).default(0).describe(`Device rotation in degrees, +/-${LIMITS.MAX_ROTATION_DEG}.`),
            })
            .optional()
            .describe('Position/size/rotation of the device frame on this page. Only meaningful when imageBase64 is present.'),
        })
        .nullable()
    )
    .min(1)
    .max(LIMITS.MAX_PAGES, `at most ${LIMITS.MAX_PAGES} pages per call — split a longer set across several calls`)
    .describe(`One entry per exported page/PNG, in order. Use null for a blank page. At most ${LIMITS.MAX_PAGES} pages at any single size; size:"all" renders every page 4 times over and fits ${ALL_SIZES_MAX_PAGES}. Over that, the call is refused before any rendering.`),
  texts: z
    .array(
      z.object({
        page: z.number().int().min(0).describe('0-based index into `pages` this text is anchored to.'),
        text: z.string().max(LIMITS.MAX_TEXT_CHARS, `at most ${LIMITS.MAX_TEXT_CHARS} characters per text layer`).describe(`The text content, at most ${LIMITS.MAX_TEXT_CHARS} characters. "\\n" forces a line break; otherwise it wraps to fit \`width\`.`),
        dx: z.number().min(-LIMITS.MAX_OFFSET).max(LIMITS.MAX_OFFSET).default(0).describe(`Horizontal offset from the page centre, as a fraction of canvas width. Limited to +/-${LIMITS.MAX_OFFSET}.`),
        dy: z.number().min(-LIMITS.MAX_OFFSET).max(LIMITS.MAX_OFFSET).default(0).describe(`Vertical offset from the default first-baseline position, as a fraction of canvas height. Limited to +/-${LIMITS.MAX_OFFSET}.`),
        width: z.number().positive().max(1).default(0.84).describe('Wrap width as a fraction of canvas width.'),
        fontSizeScale: z.number().positive().max(4).default(1).describe('Multiplier on the auto-fit size; ignored while autoFit is true.'),
        autoFit: z.boolean().default(true).describe('Shrink-to-fit within its fitGroup so the text never exceeds 3 lines or the wrap width.'),
        fitGroup: z.string().max(64).optional().describe('Texts sharing a fitGroup id are auto-fit together at one common size (e.g. the same headline repeated across every page). Omit for an independently-sized text.'),
        rotationDeg: z.number().min(-180).max(180).default(0).describe('Rotation in degrees about the centre of the first line\'s baseline.'),
        color: z.string().max(byteLimits.MAX_SHORT_TEXT_CHARS).default('#f7f7f5').describe('CSS hex color.'),
        fontFamily: z.enum(FONT_NAMES).default('Urbanist'),
      })
    )
    .max(LIMITS.MAX_TEXTS, `at most ${LIMITS.MAX_TEXTS} text layers per call`)
    .default([])
    .describe(`Zero or more text layers, at most ${LIMITS.MAX_TEXTS}. Order is z-order (later entries draw on top); each is confined to one page.`),
  backgroundFrom: z.string().max(byteLimits.MAX_SHORT_TEXT_CHARS).default('#12121a').describe('Gradient start color (top-left), hex.'),
  backgroundTo: z.string().max(byteLimits.MAX_SHORT_TEXT_CHARS).default('#2b2140').describe('Gradient end color (bottom-right), hex.'),
  joinedScene: z.boolean().default(false).describe('When true and there is more than one page, one gradient stretches across the whole set instead of repeating per page.'),
  size: z
    .enum(['6.9', '6.7', '6.5', '13ipad', 'all'])
    .default('6.9')
    .describe(`Which official App Store Connect size to export: 6.9"/6.7"/6.5" iPhone or 13" iPad, or "all" for every size (returned as a ZIP). "all" renders 4 canvases per page, so it is limited to ${ALL_SIZES_MAX_PAGES} pages per call; for a longer set, make one call per size — a single-size call carries all ${LIMITS.MAX_PAGES}.`),
};

function register(server) {
  server.registerTool(
    'render_app_store_screenshot',
    {
      title: 'App Store screenshot generator',
      description:
        'Composite one or more app screenshots into a drawn device frame (rounded bezel, Dynamic Island on ' +
        'phone-shaped canvases) with a gradient background and optional headline/caption text, and export as ' +
        'PNG at any/all of the 4 official App Store Connect sizes. A blank page (image omitted) draws no ' +
        'device, for a title card or an outro. A device positioned past the edge of its page is drawn ' +
        'spilling onto the neighbouring page too, so a set can run one screenshot into the next. ' +
        `LIMITS — this runs on a small shared host, so an over-limit call is refused immediately, before any ` +
        `rendering, with a message saying how to split it: at most ${LIMITS.MAX_PAGES} pages at any one size, ` +
        `${ALL_SIZES_MAX_PAGES} at size:"all" (which renders every page 4 times over — a longer set needs one ` +
        `call per size); at most ${LIMITS.MAX_RENDERS_PER_CALL} rendered PNGs per call (pages x sizes); ` +
        `${LIMITS.MAX_IMAGE_PIXELS / 1e6} MP per screenshot and ${LIMITS.MAX_TOTAL_IMAGE_BYTES / 1e6} MB of ` +
        `screenshot bytes summed across the whole call (send JPEG, not PNG, for a multi-page set); and at most ` +
        `${LIMITS.MAX_TEXTS} text layers of ${LIMITS.MAX_TEXT_CHARS} characters each.`,
      inputSchema: inputShape,
    },
    async (args) => {
      try {
        const outputs = await renderScreenshots(args);
        const stats = {
          sizesRendered: outputs.map((o) => ({ key: o.key, label: o.label, width: o.width, height: o.height, pageCount: o.buffers.length })),
        };
        const totalFiles = outputs.reduce((n, o) => n + o.buffers.length, 0);
        const metaResult = toolResult.ok(stats);

        if (totalFiles === 1) {
          const only = outputs[0];
          const bin = outputStore.emitBinaryOutput({
            buffer: only.buffers[0],
            mimeType: 'image/png',
            filename: 'screenshot-' + only.width + 'x' + only.height + '.png',
          });
          return { content: [...metaResult.content, ...bin.content], structuredContent: metaResult.structuredContent };
        }

        const files = [];
        outputs.forEach((o) => {
          o.buffers.forEach((buf, i) => {
            const name = o.buffers.length > 1
              ? `${o.key}/screenshot-${o.width}x${o.height}-${i + 1}.png`
              : `${o.key}/screenshot-${o.width}x${o.height}.png`;
            files.push({ name, data: buf });
          });
        });
        const zipBuf = zip(files);
        const bin = outputStore.emitBinaryOutput({ buffer: zipBuf, mimeType: 'application/zip', filename: 'app-store-screenshots.zip' });
        return { content: [...metaResult.content, ...bin.content], structuredContent: metaResult.structuredContent };
      } catch (err) {
        return toolResult.fail(err.message);
      }
    }
  );
}

module.exports = {
  register,
  toolCount: 1,
  renderScreenshots,
  plan,
  wrapAll,
  fitGroup,
  overlapsSlide,
  estimateOutputBytes,
  maxPagesFor,
  WORST_OUTPUT_BYTES_PER_MEGAPIXEL,
  LIMITS,
  SIZES,
  inputShape,
};
