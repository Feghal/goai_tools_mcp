# libheif-js — vendored, unmodified

The HEIC converter at /tools/heic decodes HEIC/HEIF in the browser. HEIC is
HEVC in a container, and no browser outside Safari will decode it, so the tool
carries a decoder rather than uploading anyone's photos to a server.

| | |
|---|---|
| Package | [`libheif-js`](https://www.npmjs.com/package/libheif-js) |
| Version | 1.19.8 |
| Tarball | https://registry.npmjs.org/libheif-js/-/libheif-js-1.19.8.tgz |
| Integrity | `sha512-vQJWusIxO7wavpON1dusciL8Go9jsIQ+EUrckauFYAiSTjcmLAsuJh3SszLpvkwPci3JcL41ek2n+LUZGFpPIQ==` |
| Upstream | https://github.com/catdad-experiments/libheif-js |
| libheif source | https://github.com/strukturag/libheif |
| Licence | **LGPL-3.0** (see `LICENSE`) |

`libheif.js` and `libheif.wasm` are copied verbatim from `libheif-wasm/` in that
tarball. Neither file has been modified.

## Why this shape

The LGPL asks that the library stay replaceable. Keeping the compiled
`libheif.wasm` as its own file — rather than the base64-inlined
`libheif-bundle.js` the package also ships — means a recipient can drop in their
own build of libheif without touching anything we wrote. Our code never links
into it; it loads it at runtime, only once someone actually drops a file.

## If you upgrade it

Re-download the tarball, check the integrity hash the registry publishes,
copy the two files again, and update the version and hash above. Do not edit
either file in place: a modified copy changes what the licence requires of us.
