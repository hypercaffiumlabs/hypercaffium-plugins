---
description: Show where the app is on BOTH stores right now (iOS App Store + Google Play), in plain English, in local time
allowed-tools: ["mcp__plugin_hypercaffium-apple_asc__asc_release_status", "mcp__plugin_hypercaffium-play_play__play_release_status", "mcp__plugin_hypercaffium-apple_asc__asc_list_apps"]
---

Give the owner a combined release status for their app on both stores.

1. In parallel, call `asc_release_status` (App Store Connect) and `play_release_status` (Google Play).
   If a tool reports "not set up", say which store is unavailable and why, then continue with the other.
2. Present one short answer, plain English, no jargon. Use this shape:

   **iOS (App Store)**
   - Live: version, state, phased-release progress if any
   - In flight: any version in review / waiting / rejected / preparing (or "nothing in flight")
   - Latest build: build number and processing state

   **Android (Google Play)**
   - Live in production: version name and code
   - Rolling out: percentage, if a staged rollout is in progress (or "no rollout in progress")
   - Other tracks: internal / alpha / beta, only if they hold something
   - Newest uploaded version code

3. Finish with a one-line "what needs attention" (for example: a rejected version, a halted rollout,
   a build still processing, or iOS and Android versions that don't match). If nothing, say "nothing needs attention".

Rules:
- All times in the owner's local time zone (the tools already convert; do not show raw UTC or Pacific offsets).
- This command is read-only. Never change anything from here.
- Do not invent facts. If a field is missing, say it is missing.
- No em dashes.
