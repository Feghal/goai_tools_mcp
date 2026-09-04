'use strict';

/* GIF89a writer: 5-bit histogram, median-cut palette, optional Floyd-Steinberg
   dithering, LZW. Ported VERBATIM from
   nginx/sites/goai/assets/gif.js's window.GOAI_GIF IIFE -- same algorithm,
   same variable names, same control flow. The only change from the browser
   source is the export shape at the bottom (module.exports instead of
   assigning window.GOAI_GIF), since this file already has zero window/DOM/
   canvas dependency: it operates purely on typed arrays. Do not "improve"
   the median-cut/dithering/LZW here -- the whole point of this port is byte-
   for-byte parity with the site's own GIF output for the same input frames.

   palette(frames, maxColors) -> {table: Uint8Array, size, lookup}
     `frames` is an array of RGBA pixel buffers (Uint8Array/Uint8ClampedArray),
     one per sampled video frame, each of length width*height*4 -- exactly
     what the source passes it (frames.map(f => f.data)), not a
     {data,width,height} wrapper object.
   map(rgba, w, h, pal, dither) -> Uint8Array of palette indices
   writer({width, height, palette, loop}) -> {frame(idx, cs), finish()}
*/

var BINS = 32768;                       // 32 x 32 x 32, five bits per channel

function bin(r, g, b) {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

// A histogram over the 5-bit cube, carrying exact channel sums so a box
// averages its real colours rather than the centres of its cells.
function histogram(frames) {
  var count = new Uint32Array(BINS);
  var sr = new Float64Array(BINS), sg = new Float64Array(BINS), sb = new Float64Array(BINS);
  for (var f = 0; f < frames.length; f++) {
    var px = frames[f];
    for (var i = 0; i < px.length; i += 4) {
      var r = px[i], g = px[i + 1], b = px[i + 2], k = bin(r, g, b);
      count[k]++; sr[k] += r; sg[k] += g; sb[k] += b;
    }
  }
  return { count: count, sr: sr, sg: sg, sb: sb };
}

function boxOf(hist, cells, start, end) {
  var lo = [255, 255, 255], hi = [0, 0, 0], total = 0;
  for (var i = start; i < end; i++) {
    var k = cells[i], n = hist.count[k];
    total += n;
    var c = [hist.sr[k] / n, hist.sg[k] / n, hist.sb[k] / n];
    for (var ch = 0; ch < 3; ch++) {
      if (c[ch] < lo[ch]) lo[ch] = c[ch];
      if (c[ch] > hi[ch]) hi[ch] = c[ch];
    }
  }
  return { start: start, end: end, lo: lo, hi: hi, count: total,
           range: Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) };
}

function palette(frames, maxColors) {
  var hist = histogram(frames);
  var cells = [];
  for (var k = 0; k < BINS; k++) if (hist.count[k]) cells.push(k);
  var mean = function (k, ch) {
    var s = ch === 0 ? hist.sr : ch === 1 ? hist.sg : hist.sb;
    return s[k] / hist.count[k];
  };

  var boxes = [boxOf(hist, cells, 0, cells.length)];
  while (boxes.length < maxColors) {
    // Split the box that is both wide and populous: splitting a wide box
    // holding four pixels spends a palette slot on nothing anyone sees.
    var pick = -1, best = 0;
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (b.end - b.start < 2) continue;
      var score = b.range * Math.cbrt(b.count);
      if (score > best) { best = score; pick = i; }
    }
    if (pick < 0) break;
    var box = boxes[pick];
    var axis = box.hi[0] - box.lo[0] >= box.hi[1] - box.lo[1] &&
               box.hi[0] - box.lo[0] >= box.hi[2] - box.lo[2] ? 0
             : box.hi[1] - box.lo[1] >= box.hi[2] - box.lo[2] ? 1 : 2;
    var slice = cells.slice(box.start, box.end);
    slice.sort(function (x, y) { return mean(x, axis) - mean(y, axis) || x - y; });
    for (var j = 0; j < slice.length; j++) cells[box.start + j] = slice[j];
    // Cut at the median pixel, not the median cell, so both halves carry a
    // similar share of the picture.
    var half = box.count / 2, run = 0, cut = box.start;
    for (var m = box.start; m < box.end - 1; m++) {
      run += hist.count[cells[m]];
      cut = m + 1;
      if (run >= half) break;
    }
    boxes.splice(pick, 1, boxOf(hist, cells, box.start, cut),
                          boxOf(hist, cells, cut, box.end));
  }

  var size = 2;
  while (size < boxes.length) size <<= 1;
  var table = new Uint8Array(size * 3);
  for (var t = 0; t < boxes.length; t++) {
    var bx = boxes[t], rr = 0, gg = 0, bb = 0, n = 0;
    for (var c = bx.start; c < bx.end; c++) {
      var key = cells[c];
      rr += hist.sr[key]; gg += hist.sg[key]; bb += hist.sb[key]; n += hist.count[key];
    }
    table[t * 3] = Math.round(rr / n);
    table[t * 3 + 1] = Math.round(gg / n);
    table[t * 3 + 2] = Math.round(bb / n);
  }

  // One nearest-colour answer per cell of the cube, resolved once: the
  // per-pixel search would otherwise repeat the same 256 comparisons
  // millions of times.
  var lookup = new Uint8Array(BINS);
  for (var cell = 0; cell < BINS; cell++) {
    var cr = ((cell >> 10) & 31) * 8 + 4, cg = ((cell >> 5) & 31) * 8 + 4, cb = (cell & 31) * 8 + 4;
    var pickIdx = 0, dist = Infinity;
    for (var p = 0; p < boxes.length; p++) {
      var dr = cr - table[p * 3], dg = cg - table[p * 3 + 1], db = cb - table[p * 3 + 2];
      var d = dr * dr + dg * dg + db * db;
      if (d < dist) { dist = d; pickIdx = p; }
    }
    lookup[cell] = pickIdx;
  }
  return { table: table, size: size, used: boxes.length, lookup: lookup };
}

function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

function map(rgba, width, height, pal, dither) {
  var out = new Uint8Array(width * height);
  if (!dither) {
    for (var i = 0, p = 0; p < out.length; i += 4, p++) {
      out[p] = pal.lookup[bin(rgba[i], rgba[i + 1], rgba[i + 2])];
    }
    return out;
  }
  // Floyd-Steinberg over two rolling error rows, serpentine so the error
  // does not drift consistently to the right and print a diagonal weave.
  var cur = new Float32Array((width + 2) * 3), nxt = new Float32Array((width + 2) * 3);
  for (var y = 0; y < height; y++) {
    var toRight = (y & 1) === 0;
    for (var s = 0; s < nxt.length; s++) { cur[s] = nxt[s]; nxt[s] = 0; }
    for (var n = 0; n < width; n++) {
      var x = toRight ? n : width - 1 - n;
      var src = (y * width + x) * 4, e = (x + 1) * 3;
      var r = clamp(rgba[src] + cur[e]), g = clamp(rgba[src + 1] + cur[e + 1]), b = clamp(rgba[src + 2] + cur[e + 2]);
      var idx = pal.lookup[bin(Math.round(r), Math.round(g), Math.round(b))];
      out[y * width + x] = idx;
      var er = r - pal.table[idx * 3], eg = g - pal.table[idx * 3 + 1], eb = b - pal.table[idx * 3 + 2];
      var ahead = toRight ? e + 3 : e - 3, behind = toRight ? e - 3 : e + 3;
      cur[ahead] += er * 7 / 16; cur[ahead + 1] += eg * 7 / 16; cur[ahead + 2] += eb * 7 / 16;
      nxt[behind] += er * 3 / 16; nxt[behind + 1] += eg * 3 / 16; nxt[behind + 2] += eb * 3 / 16;
      nxt[e] += er * 5 / 16; nxt[e + 1] += eg * 5 / 16; nxt[e + 2] += eb * 5 / 16;
      nxt[ahead] += er / 16; nxt[ahead + 1] += eg / 16; nxt[ahead + 2] += eb / 16;
    }
  }
  return out;
}

// A dictionary of at most 4096 entries, held in typed arrays: a Map keyed on
// the same numbers spends more time boxing keys than compressing.
var HASH = 9973;
var htKey = new Int32Array(HASH), htVal = new Int32Array(HASH);

function lzw(indices, minCodeSize, push) {
  var clear = 1 << minCodeSize, eoi = clear + 1;
  var codeSize = minCodeSize + 1, next = eoi + 1;
  var cur = 0, bits = 0, block = new Uint8Array(255), fill = 0;
  htKey.fill(-1);
  function flush() {
    // Image data travels in sub-blocks of at most 255 bytes, each preceded
    // by its own length.
    push(fill);
    for (var i = 0; i < fill; i++) push(block[i]);
    fill = 0;
  }
  function emit(code) {
    cur |= code << bits; bits += codeSize;
    while (bits >= 8) {
      block[fill++] = cur & 255; cur >>>= 8; bits -= 8;
      if (fill === 255) flush();
    }
  }
  function slot(key) {
    var h = (Math.imul(key, 2654435761) >>> 0) % HASH;
    while (htKey[h] !== -1 && htKey[h] !== key) { h++; if (h === HASH) h = 0; }
    return h;
  }
  emit(clear);
  var prefix = indices[0];
  for (var i = 1; i < indices.length; i++) {
    var k = indices[i], key = prefix * 4096 + k, at = slot(key);
    if (htKey[at] === key) { prefix = htVal[at]; continue; }
    emit(prefix);
    if (next === 4096) {
      emit(clear); htKey.fill(-1); next = eoi + 1; codeSize = minCodeSize + 1;
    } else {
      htKey[at] = key; htVal[at] = next++;
      if (next === (1 << codeSize) + 1 && codeSize < 12) codeSize++;
    }
    prefix = k;
  }
  emit(prefix); emit(eoi);
  if (bits > 0) block[fill++] = cur & 255;
  if (fill) flush();
  push(0);
}

function writer(opts) {
  var pal = opts.palette, bytes = new Uint8Array(1 << 16), length = 0;
  function push(b) {
    if (length === bytes.length) {
      var grown = new Uint8Array(bytes.length * 2);
      grown.set(bytes); bytes = grown;
    }
    bytes[length++] = b;
  }
  function short(v) { push(v & 255); push((v >> 8) & 255); }
  function str(s) { for (var i = 0; i < s.length; i++) push(s.charCodeAt(i)); }

  var exp = Math.max(1, Math.round(Math.log(pal.size) / Math.LN2));
  str("GIF89a");
  short(opts.width); short(opts.height);
  push(0x80 | (7 << 4) | (exp - 1));    // global table, 8-bit source, its size
  push(0); push(0);
  for (var i = 0; i < pal.size * 3; i++) push(pal.table[i] || 0);
  if (opts.loop !== false) {
    str("\x21\xFF\x0BNETSCAPE2.0\x03\x01"); short(0); push(0);
  }
  return {
    frame: function (indices, centiseconds) {
      push(0x21); push(0xF9); push(4);
      push(1 << 2);                     // do not dispose; no transparency
      short(centiseconds); push(0); push(0);
      push(0x2C); short(0); short(0); short(opts.width); short(opts.height); push(0);
      var min = Math.max(2, exp);
      push(min);
      lzw(indices, min, push);
    },
    finish: function () { push(0x3B); return bytes.slice(0, length); }
  };
}

module.exports = { palette: palette, map: map, writer: writer };
