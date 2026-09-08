# Third-party notices

The code in this repository is ISC licensed — see `LICENSE`. Two sets of
third-party assets are vendored here unmodified, each under its own terms and
each carrying its own notice in place.

## libheif-js

`goai_tools_mcp/utils/vendor/libheif/`

Used by `convert_heic_to_jpg_png` to decode HEIC/HEIF, a format Node's image
stack does not read on its own. Vendored rather than installed so the build
does not depend on a registry fetch for a WASM binary.

Full terms in that directory's `LICENSE`, with the provenance and
"unmodified" statement in its `NOTICE.md`.

## Google Fonts

`goai_tools_mcp/utils/fonts/`

22 `.ttf` faces used by `render_app_store_screenshot` for headline typography.
Downloaded unmodified from Google Fonts and licensed under the
[SIL Open Font License 1.1](https://openfontlicense.org/).

The per-family list and the OFL terms are in that directory's `NOTICE.md`.
