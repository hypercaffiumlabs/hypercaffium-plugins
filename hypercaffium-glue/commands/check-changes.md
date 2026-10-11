---
description: Report what changed on BOTH stores since the last check (review state, builds, rollouts, new reviews), in plain English and local time
allowed-tools: ["mcp__plugin_hypercaffium-apple_asc__asc_check_changes", "mcp__plugin_hypercaffium-play_play__play_check_changes"]
---

Tell the owner what has changed on the App Store and Google Play since the last time this was checked.

1. In parallel, call `asc_check_changes` and `play_check_changes`.
   If one store reports "not set up", say which and continue with the other.
2. If a store returned `baseline: true`, say that this was the first check and a baseline was saved.
3. Otherwise list the changes per store in plain English (the tools already phrase them). Put the important ones first:
   rejections or unresolved issues, version or submission state changes, rollout progress, new reviews with low ratings.
   If nothing changed on a store, say "no change" in one line.
4. End with one line: "needs attention" (a rejection, a halted rollout, a build that failed processing, a 1-2 star review) or "nothing needs attention".

Rules:
- All times in the owner's local time zone.
- Read-only. Never change anything from this command.
- Do not invent changes; report only what the tools returned.
- No em dashes.
