'use strict';

const path = require('path');
const { GlobalFonts } = require('@napi-rs/canvas');

// The 22-family list from the browser tool (screenshots.html's FONTS table),
// each mapped to the bundled file that actually rasterizes it server-side.
// `n` is the display/API name a caller passes as `fontFamily`; `family` is
// what gets registered with @napi-rs/canvas and used in ctx.font strings.
//
// Georgia and Courier New are not fonts at all -- they are names of faces
// bundled with desktop operating systems, absent on a Linux server. Rather
// than fail or silently substitute a visually different face, this uses
// Google's own metric-compatible replacements, designed for exactly this
// substitution and licensed for it: Gelasio for Georgia, Cousine for
// Courier New. Every other family here IS the real Google Fonts face the
// browser tool itself loads. See NOTICE.md for full licensing.
const FONTS = [
  { n: 'Urbanist', family: 'Urbanist', file: 'Urbanist-700.ttf', weight: 700 },
  { n: 'Inter', family: 'Inter', file: 'Inter-700.ttf', weight: 700 },
  { n: 'Poppins', family: 'Poppins', file: 'Poppins-700.ttf', weight: 700 },
  { n: 'Montserrat', family: 'Montserrat', file: 'Montserrat-800.ttf', weight: 800 },
  { n: 'Manrope', family: 'Manrope', file: 'Manrope-800.ttf', weight: 800 },
  { n: 'Rubik', family: 'Rubik', file: 'Rubik-700.ttf', weight: 700 },
  { n: 'Nunito', family: 'Nunito', file: 'Nunito-800.ttf', weight: 800 },
  { n: 'Fredoka', family: 'Fredoka', file: 'Fredoka-600.ttf', weight: 600 },
  { n: 'Space Grotesk', family: 'Space Grotesk', file: 'SpaceGrotesk-700.ttf', weight: 700 },
  { n: 'Oswald', family: 'Oswald', file: 'Oswald-600.ttf', weight: 600 },
  { n: 'Bebas Neue', family: 'Bebas Neue', file: 'BebasNeue-400.ttf', weight: 400 },
  { n: 'Anton', family: 'Anton', file: 'Anton-400.ttf', weight: 400 },
  { n: 'Archivo Black', family: 'Archivo Black', file: 'ArchivoBlack-400.ttf', weight: 400 },
  { n: 'Playfair Display', family: 'Playfair Display', file: 'PlayfairDisplay-700.ttf', weight: 700 },
  { n: 'DM Serif Display', family: 'DM Serif Display', file: 'DMSerifDisplay-400.ttf', weight: 400 },
  { n: 'Merriweather', family: 'Merriweather', file: 'Merriweather-700.ttf', weight: 700 },
  { n: 'Lora', family: 'Lora', file: 'Lora-700.ttf', weight: 700 },
  { n: 'Georgia', family: 'Gelasio', file: 'Gelasio-700.ttf', weight: 700 }, // substitute, see above
  { n: 'JetBrains Mono', family: 'JetBrains Mono', file: 'JetBrainsMono-700.ttf', weight: 700 },
  { n: 'Courier', family: 'Cousine', file: 'Cousine-700.ttf', weight: 700 }, // substitute, see above
  { n: 'Caveat', family: 'Caveat', file: 'Caveat-700.ttf', weight: 700 },
  { n: 'Pacifico', family: 'Pacifico', file: 'Pacifico-400.ttf', weight: 400 },
];

const byName = Object.create(null);
FONTS.forEach((f) => { byName[f.n] = f; });

let registered = false;
// Registered once at process boot (called from server.js), not per-request:
// GlobalFonts is process-global state in @napi-rs/canvas, and re-registering
// on every call would be wasted I/O for zero benefit.
function registerAll() {
  if (registered) return;
  FONTS.forEach((f) => {
    const ok = GlobalFonts.registerFromPath(path.join(__dirname, f.file), f.family);
    if (!ok) console.error(`Failed to register font: ${f.n} (${f.file})`);
  });
  registered = true;
}

function fontByName(name) {
  return byName[name] || byName.Urbanist;
}

module.exports = { FONTS, registerAll, fontByName };
