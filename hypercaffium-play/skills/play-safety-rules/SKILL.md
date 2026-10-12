---
name: play-safety-rules
description: Use when working with Google Play Console, the Play Store, Android release tracks, staged rollouts, app bundles, store listing text and images, review replies, or subscriptions. Explains the play_ tools and the mandatory prepare-then-apply protocol for any change.
version: 0.12.0
---

# Google Play Console: how to use these tools safely

Explain what you are about to do in plain English before any change, and wait for an explicit "yes" from the owner.

## Reading (always safe)

| Tool | Use it for |
|---|---|
| `play_release_status` | "Where is my Android app?" in one call: live, staged rollout %, other tracks, newest version code |
| `play_check_setup` | First step if anything fails; also shows whether writes are switched on |
| `play_list_tracks`, `play_list_bundles`, `play_list_reviews` | Focused lookups |
| `play_search_api` -> `play_describe_method` -> `play_call` | Anything else Google's API offers (145 methods), reads only. packageName and editId are filled in automatically |
| `play_subscription_overview` | Subscriptions and base plans |
| `play_check_changes` | What changed since the last check (release status, rollout %, new reviews). The first call saves a baseline |
| `play_audit_log` | The activity log |

## Changing things: ALWAYS two steps

1. **`play_prepare_change`** with one or more `changes` (`methodId`, `params`, `body`). It changes nothing. It returns each exact request, current value next to new value, a **tier**, and a one-time **ticket** (valid 10 minutes). Edit-based changes (listings, tracks, details...) in one ticket are applied inside ONE Play edit and committed together or not at all.
2. Explain the preview to the owner in plain English: what changes, from what to what, and that most Play changes take effect as soon as they are committed.
3. After the owner's explicit yes, **`play_apply_change`** with the ticket. If any change fails, nothing is committed and the edit is discarded.

Never work around a refusal: not by calling `play_call` with a write, and not by re-preparing with edited values after the owner approved a different preview.

### Release workflows (each only PREPARES a ticket)

| Goal | Tool |
|---|---|
| Put version code(s) on a track with a status, rollout % and notes | `play_set_release` |
| Ramp, halt, resume or complete a staged rollout | `play_rollout` (increase needs a larger fraction; complete replaces the older release) |
| Promote one track's release to another (production defaults to 10%) | `play_promote_release` |
| Change the notes of a draft, in-progress or halted release | `play_set_release_notes` |

The tools check the version code was really uploaded (builds arrive from your own build system). Google lists BOTH the rolling-out release and the older completed one on a track; the tools always send the full current list with only the intended change, and say what a new release replaces. Open only one Play edit at a time (a second one discards the first). Offer the next rollout step; never advance a rollout unprompted.

### Reviews, listing and images (each only PREPARES a ticket)

| Goal | Tool | Permission needed in Play Console |
|---|---|---|
| Reply publicly to a review (350 chars) | `play_reply_to_review` | Reply to reviews |
| Edit title / short / full description | `play_edit_listing` | Manage store presence |
| Upload icon, feature graphic, screenshots | `play_upload_images` (adds only; all-or-nothing commit) | Manage store presence |
| Replace a whole image set (e.g. all phone screenshots) | `play_replace_images` (removes the old set and uploads the new one in ONE edit; the preview lists every removed image with a link to save it) | Manage store presence |

### App bundles

`play_upload_bundle` uploads an .aab (and optionally mapping.txt) and places it on a track in ONE edit; production uploads are always a draft. Only with the "uploads" switch on; most owners upload with EAS or Gradle, so ask before suggesting it.

### Testers

`play_list_testers` shows the Google Groups on each testing track; `play_set_testers` adds or removes groups (Tier 2, inside one edit). Google's API does not manage individual tester email lists; those are console-only.

### Subscription prices (each only PREPARES a ticket; permission: Manage orders and subscriptions)

| Goal | Tool |
|---|---|
| Change a base plan's price | `play_set_subscription_price`: Google converts it to each region's currency; the preview is a per-region table. It applies to **new subscribers only**. |
| Move existing subscribers to the current price | `play_migrate_subscription_prices`: changes what paying customers are charged. Read its `customerImpact` to the owner, confirm the regions and OPT_IN / OPT_OUT, and only then ask for a yes. |

Never apply a price change or migration inferred from a vague request: ask for the exact amount, base plan and regions. Re-entering the current price can still move some regions (Google's conversion drifts); point out every row whose price changes.

Granting a permission: Users and permissions, the service account, Manage permissions, tick it, Apply, Save changes, **then click Yes on the "Are you sure" prompt** (nothing saves until Yes). Ask the owner before each grant.

Clearing a release note: send `text: ""` for that language (leaving notes out keeps them).

### Tiers (enforced by the server)

- **Tier 1:** none. Nearly everything on Google Play goes live on commit, so everything needs the owner's "yes".
- **Tier 2 (preview, then the owner's "yes"):** all changes: listings, tracks and rollouts, details, public review replies.
- **Tier 3 (blocked, no ticket):** every delete, direct edit control (commit/delete/insert/validate), and every area whose feature switch is off (users, app signing and refunds are off unless the owner switched them on).

### Feature switches (enforced by the server)

The owner chooses which areas this plugin may change, grouped by risk: Low (testing), Medium (listing, review replies), High (releases, prices, uploading app files, everything else in the API) and Critical (users and permissions, app signing, refunds and orders). A switched-off area is refused for every route, including `play_prepare_change`. `play_settings` shows the current switches.

- If a change is refused because its feature is off, tell the owner which switch it is and that `/hypercaffium-play:setup` changes it. Do not look for another way.
- **Critical** changes are previewed like any other, but can only be applied with `play_apply_sensitive_change`. Before applying, say plainly what could go wrong (app signing key rotation cannot be undone; a refund sends a customer's money back).
- Never switch a feature on, never call `play_save_settings` unless the owner is choosing settings right now, and never edit the settings file directly. Critical features can only be switched on by the owner in a terminal menu; `play_save_settings` refuses it.

### The kill switch

Writes are OFF unless the config file has `"writesEnabled": true`. If `play_apply_change` says writes are switched off, tell the owner how to turn them on; do not look for another way.

### Not available

Uploading app bundles (builds come from your build system), creating an app, and the content-rating questionnaire are console-only. Say so plainly; do not try to drive a browser. See `COVERAGE.md`.

## Habits

1. **Using the Play Console in a browser while an API edit is open discards the API edit.** Keep edits short.
2. **Releases are not instant.** After a rollout change Google may take hours to review. Report status, do not promise timing.
3. **Times are shown in the configured time zone** (`timezone` in the config file). Never show raw offsets.
4. **After any applied change**, confirm it by reading the resource back, and tell the owner the audit log has the before and after.
