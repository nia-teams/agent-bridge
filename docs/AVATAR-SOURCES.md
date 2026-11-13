# External Agent default avatars

Each adapter owns `src/branding.ts`, shipping its product name and a 256×256 PNG
data URL. Assets are resized/quantized with sharp (256 colours, PNG compression
level 9), all under 64 KiB. Core transports these opaque values; the Teams server
contains no product registry or brand assets. Standalone packages inline them.

Sources retrieved 2026-11-10 (brand marks belong to their respective owners):

- DSH: original official DeepSeek Harness 512×512 whale, resized to 256×256.
- Antigravity: https://antigravity.google/assets/image/antigravity-logo.png (276×276).
- Claude: https://claude.ai/favicon.svg (official Claude orange starburst, vector).
- Codex: OpenAI knot vector from https://github.com/lobehub/lobe-icons/blob/master/packages/static-svg/icons/openai.svg (community distribution of the OpenAI brand mark; not an independently invented Codex logo).
- WorkBuddy: application icon extracted from WorkBuddy.app and resized to 256×256.
- Doubao: https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/favicon/new-doubao/192x192.png (official application icon, resized to 256×256).


## Protocol

`pairHost`, `BridgeClientOptions`, and `SessionHostOptions` accept optional
`clientName` and `avatar`. Pairing/start and the signed challenge/lease exchange
carry the same fields. Every reconnect sends the installed adapter’s current
branding, allowing old paired hosts to self-heal after upgrading without re-pairing.
No provider identifier or registry is required. New adapters own only their own
branding, and need no server changes. Omission during lease authentication leaves
existing branding unchanged. Rebinding replaces the previous host branding.

The server accepts only canonical `data:image/png;base64,...` images (64 KiB
compressed, at most 1024×1024 pixels), not SVG or remote URLs. `avatarDataUrl` and
`avatarUrl` are input aliases for the same PNG-only value. Invalid supplied values
fail with 400; omitted values preserve compatibility with old clients. The server
stores the data and a 12-character SHA-256 cache key, and returns image URLs rather
than inline data in identity and pairing-context JSON. Host-avatar URLs with the
current hash are immutable; stale hashes return 404/no-store. Pairing image responses use `Cache-Control: private, no-store` and expire with
their pairing records. Browser approval does not commit host branding: only
successful registration proof in `pairing/complete` replaces host metadata. Custom user avatars win.
