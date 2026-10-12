---
description: Where your app is right now on the App Store, and on Google Play too if hypercaffium-play is installed. Plain English, local time.
allowed-tools: ["mcp__plugin_hypercaffium-apple_asc__asc_release_status", "mcp__plugin_hypercaffium-apple_asc__asc_list_apps", "mcp__plugin_hypercaffium-play_play__play_release_status"]
---

Give the owner a release status for their app: the App Store always, and Google Play when the hypercaffium-play plugin is available.

1. Call `asc_release_status`. If the tool `play_release_status` (from the hypercaffium-play plugin) is available in this session, call it in parallel.
   - If `play_release_status` is not available, report the App Store only, and add one line at the end: "Google Play is not included: the hypercaffium-play plugin is not installed (or, if you just installed it, restart Claude Code once)."
   - If a tool reports "not set up", say which store is unavailable and why, then continue with the other.
2. Present one short answer, plain English, no jargon. Use this shape:

   **iOS (App Store)**
   - Live: version, state, phased-release progress if any
   - In flight: any version in review / waiting / rejected / preparing (or "nothing in flight")
   - Latest build: build number and processing state

   **Android (Google Play)** (only when available)
   - Live in production: version name and code
   - Rolling out: percentage, if a staged rollout is in progress (or "no rollout in progress")
   - Other tracks: internal / alpha / beta, only if they hold something
   - Newest uploaded version code

3. Finish with a one-line "what needs attention" (for example: a rejected version, a halted rollout, a build still processing, or iOS and Android versions that don't match). If nothing, say "nothing needs attention".

Rules:
- All times in the owner's local time zone (the tools already convert; do not show raw UTC or Pacific offsets).
- This command is read-only. Never change anything from here.
- Do not invent facts. If a field is missing, say it is missing.
- No em dashes.
