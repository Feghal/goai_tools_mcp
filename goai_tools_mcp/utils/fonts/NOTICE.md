# Bundled fonts

All 22 `.ttf` files in this directory are downloaded, unmodified, from
Google Fonts (`fonts.googleapis.com` / `fonts.gstatic.com`) and are licensed
under the [SIL Open Font License 1.1](https://openfontlicense.org/), which
permits redistribution, including bundled inside software, provided the
fonts are not sold on their own and any modified version is renamed. These
are unmodified, so no renaming is required. Full license text:
https://scripts.sil.org/cms/scripts/page.php?site_id=nrsi&id=OFL

Families bundled, weight used, and source file:

| Display name | Family used to render | Weight | File |
|---|---|---|---|
| Urbanist | Urbanist | 700 | Urbanist-700.ttf |
| Inter | Inter | 700 | Inter-700.ttf |
| Poppins | Poppins | 700 | Poppins-700.ttf |
| Montserrat | Montserrat | 800 | Montserrat-800.ttf |
| Manrope | Manrope | 800 | Manrope-800.ttf |
| Rubik | Rubik | 700 | Rubik-700.ttf |
| Nunito | Nunito | 800 | Nunito-800.ttf |
| Fredoka | Fredoka | 600 | Fredoka-600.ttf |
| Space Grotesk | Space Grotesk | 700 | SpaceGrotesk-700.ttf |
| Oswald | Oswald | 600 | Oswald-600.ttf |
| Bebas Neue | Bebas Neue | 400 | BebasNeue-400.ttf |
| Anton | Anton | 400 | Anton-400.ttf |
| Archivo Black | Archivo Black | 400 | ArchivoBlack-400.ttf |
| Playfair Display | Playfair Display | 700 | PlayfairDisplay-700.ttf |
| DM Serif Display | DM Serif Display | 400 | DMSerifDisplay-400.ttf |
| Merriweather | Merriweather | 700 | Merriweather-700.ttf |
| Lora | Lora | 700 | Lora-700.ttf |
| **Georgia** | **Gelasio** | 700 | Gelasio-700.ttf |
| JetBrains Mono | JetBrains Mono | 700 | JetBrainsMono-700.ttf |
| **Courier** | **Cousine** | 700 | Cousine-700.ttf |
| Caveat | Caveat | 700 | Caveat-700.ttf |
| Pacifico | Pacifico | 400 | Pacifico-400.ttf |

## Why Gelasio and Cousine

The browser tool this service ports (`tools/screenshots.html`) offers
"Georgia" and "Courier" as options, falling back through the OS's own
Georgia / Courier New when the browser has them — real fonts bundled with
Windows and macOS, but under a proprietary license (Georgia: Ascender/
Microsoft; Courier New: Monotype) that forbids redistribution. Neither is
installed on a Linux server, and there is no way to license them for this
image.

Google publishes Gelasio and Cousine specifically as free, metric-compatible
replacements for Georgia and Courier New — same advance widths, same
line-height metrics, so text laid out against one reflows identically
against the other; only the letterforms differ. That makes them the closest
available substitute rather than a generic fallback. The API's `fontFamily`
parameter still accepts and reports `"Georgia"` / `"Courier"` as the
family name, matching the site; only the actual glyph outlines used to
rasterize differ from what a Windows/macOS browser would show.
