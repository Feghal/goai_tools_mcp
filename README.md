# GO AI Tools — MCP server

31 deterministic utility tools over one public MCP endpoint. No API key, no
account, no model calls.

Hosted at **`https://goaichat.app/mcp-tools/mcp`** — documentation and a
browser version of every tool at <https://goaichat.app/mcp-tools>. Listed in the
[official MCP registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=app.goaichat/tools)
as `app.goaichat/tools`.

Every tool here is a pure function of its input: image codecs, colour maths,
arithmetic, file parsing. Nothing calls a language model, which is exactly why
it can be free.

## Use the hosted server

Claude Code:

```bash
claude mcp add --transport http goai-tools https://goaichat.app/mcp-tools/mcp
```

Cursor (`mcp.json`) or Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "goai-tools": {
      "type": "http",
      "url": "https://goaichat.app/mcp-tools/mcp"
    }
  }
}
```

There is no pairing step because there is nothing to pair. Streamable HTTP
transport; your client discovers all 31 tools on its next handshake.

## The tools

**Images and media**

| Tool | What it does |
|---|---|
| `strip_image_metadata` | Removes EXIF/GPS/XMP/IPTC and PNG text chunks without re-encoding — the compressed image data comes back byte-identical, and the tool verifies that before returning |
| `convert_heic_to_jpg_png` | HEIC/HEIF → JPG or PNG |
| `image_compress` | Compress to JPEG, WebP or AVIF at a chosen quality |
| `image_compression_curve` | Size-vs-quality curve, so you can pick a setting from data |
| `resize_images` | Batch resize with real platform presets |
| `convert_video_to_gif` | A few seconds of screen recording → GIF, MP4 or WebM |

**Shipping an iOS app**

| Tool | What it does |
|---|---|
| `render_app_store_screenshot` | App Store screenshots with device frames, headlines, backgrounds |
| `generate_app_icon_set` | Full iOS + Android icon set, including an Xcode `Contents.json` |
| `generate_favicon_set` | Favicons plus a web app manifest |
| `build_app_store_link` | Campaign links with attribution tokens and a QR code |
| `calculate_app_store_net_revenue` | Net revenue after commission and tax |
| `appstore_search` | Search one App Store storefront |
| `appstore_compare_markets` | Compare a listing across country storefronts |
| `build_app_privacy_label` | App Store privacy nutrition label checklist |
| `inspect_mobileprovision` | Entitlements, devices and expiry from a `.mobileprovision` |
| `check_strings_files` | iOS `.strings` linting — missing, duplicate and stale keys |

**Colour and layout**

| Tool | What it does |
|---|---|
| `check_contrast` | WCAG 2 and APCA contrast |
| `find_nearest_passing_color` | Nearest passing colour, hue preserved |
| `oklch_convert` | OKLCH ↔ hex, RGB, HSL |
| `oklch_ramp` | OKLCH swatch ramp as a CSS custom-property block |
| `css_clamp_calculator` | Fluid `clamp()` from two breakpoints |

**AI helpers**

| Tool | What it does |
|---|---|
| `estimate_ai_tokens` | Heuristic token count, context fit and cost — *not* a real BPE tokenizer |
| `recommend_ai_model` | Suggests a model for a described task |

**Everyday**

| Tool | What it does |
|---|---|
| `calculate_tdee` | TDEE and macro targets |
| `calculate_bmi_and_body_fat` | BMI and US Navy body fat |
| `project_weight_goal_date` | Goal-date projection at a given rate |
| `recipe_scale` | Scale servings, with gram weights |
| `recipe_convert_ingredient` | Cups → grams using per-ingredient densities |
| `plant_watering_calendar` | Watering schedule as an `.ics` file |
| `estimate_window_light` | How much light a window gives a houseplant |
| `bpm_delay_calculator` | Tap tempo, BPM → delay times and bar lengths |

Plus one resource: `resource://goai-tools/ios-screens.json`, a static table of
iPhone/iPad resolutions, points, PPI and safe-area type.

## Limits

These are deliberate and the tools report them by name when you cross one.

- **4 MB per file, and per call in aggregate.** Inputs arrive base64-encoded
  inside the JSON request, so this is the decoded size.
- **One heavy call at a time.** Screenshot rendering and video conversion are
  memory-hungry; a second concurrent heavy call is refused in milliseconds
  rather than queued, so you get an answer instead of a timeout.
- **Short clips only** for `convert_video_to_gif`. It turns a few seconds of
  screen recording into a GIF, it is not a transcoder.
- **1200 requests a minute** per caller on the hosted instance.
- **Results expire.** Anything too large to return inline comes back as a
  one-shot link, deleted on first download or after an hour.

## Run it yourself

```bash
docker compose up --build          # http://localhost:3000/mcp
```

Or without Docker:

```bash
cd goai_tools_mcp && npm install && npm start
```

```bash
npm test                            # every tool ships with real tests
```

Requires Node 20.

### Configuration

Everything has a working default; the server boots with no configuration at
all. The ones worth knowing:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `MCP_API_KEY` | *(empty)* | **Empty means fully public** — no key, anyone with the URL can call every tool. That is the intended deployment, and the service logs `auth: DISABLED` once at boot so it is never a surprise. Set it and every request must carry `x-api-key` or `Authorization: Bearer`. |
| `MAX_INPUT_BYTES` | `4000000` | Decoded bytes per file. Express's body limit is derived from it. |
| `MCP_RATE_LIMIT_MAX` | `1200` | Requests per window per client |
| `PUBLIC_BASE_URL` | — | Required in production; prefixes the `/files/:token` download links |
| `OUTPUT_TTL_MS` | `3600000` | How long a generated file stays fetchable |

`MAX_INPUT_BYTES` is tuned against the per-tool bounds in
`goai_tools_mcp/utils/byteLimits.js` — raising it without reading that file
will let requests in that the tools then refuse.

## Licence

ISC, see `package.json`.

Two sets of third-party assets are vendored, unmodified, each with its own
notice:

- `utils/vendor/libheif/` — [libheif-js](https://github.com/catdad-experiments/libheif-js),
  for HEIC/HEIF decoding. See its `LICENSE` and `NOTICE.md`.
- `utils/fonts/` — 22 Google Fonts faces under the
  [SIL Open Font License 1.1](https://openfontlicense.org/), used by the
  screenshot renderer. See `NOTICE.md`.
