---
name: asc-safety-rules
description: Use when working with App Store Connect, TestFlight, iOS build status, release notes, listing text, screenshots, submitting for App Review, phased release, subscriptions and prices, customer reviews, or App Review details. Explains the asc_ tools and the mandatory prepare-then-apply protocol for any change.
version: 0.7.1
---

# App Store Connect: how to use these tools safely

Explain what you are about to do in plain English before any change, and wait for an explicit "yes" from the owner for anything above Tier 1.

## Reading (always safe)

| Tool | Use it for |
|---|---|
| `asc_release_overview` | One answer about a release: state, build, per-locale text, screenshots, review details, and a **pre-flight checklist** |
| `asc_release_status` | App-level "where is it?": live, in flight, latest builds |
| `asc_subscription_overview`, `asc_subscription_prices`, `asc_find_price_point` | Subscriptions, per-territory prices, allowed price points |
| `asc_review_inbox`, `asc_testflight_overview` | Reviews needing a reply; TestFlight groups, testers, builds |
| `asc_check_changes` | What changed since the last check (states, builds, submissions, new reviews). The first call saves a baseline |
| `asc_list_*`, `asc_search_api` -> `asc_describe_operation` -> `asc_call` | Anything else in Apple's API (1,300+ operations). `asc_describe_operation` shows the exact body shape for writes |
| `asc_audit_log` | What the plugin has done |

## Changing things: ALWAYS prepare, then apply

Every change tool below only **prepares**: it returns a preview (before and after), a tier, and a one-time ticket (10 minutes). Nothing changes until `asc_apply_change` (or `asc_apply_safe_change` for Tier 1) is called with that ticket. Multi-step flows are ONE ticket that runs in order and stops at the first failure.

| Goal | Tool |
|---|---|
| Release notes / listing text | `asc_set_release_notes`, `asc_edit_listing` |
| Choose the build | `asc_attach_build` |
| Start the next version | `asc_create_version` |
| Screenshots | `asc_upload_screenshots` (adds), `asc_clear_screenshots` (removes, Tier 2, draft only) |
| Submit for review | `asc_submit_for_review` (runs the pre-flight; returns problems and NO ticket if blocked) |
| Cancel a submission | `asc_cancel_submission` |
| Phased release | `asc_phased_release` (enable / pause / resume / complete) |
| Release an approved version | `asc_release_version` |
| Subscription price | `asc_set_subscription_price` (per-territory preview; `preserveCurrentPrice` defaults to true) |
| Subscription name / localization / intro offers | `asc_edit_subscription`, `asc_edit_subscription_localization`, `asc_create_intro_offer` |
| Reply to a customer review (PUBLIC) | `asc_reply_to_review` (Tier 2) |
| App Review contact / demo account / notes | `asc_edit_review_details` (Tier 1 on a draft; the demo password is never shown or logged) |
| App name, subtitle, privacy URLs | `asc_edit_app_info` (Tier 2: public on release) |
| TestFlight notes / testers / builds | `asc_testflight_set_notes` (Tier 1), `asc_testflight_add_tester` and `asc_testflight_add_build_to_group` (Tier 2) |
| Anything else (promo offers, offer codes, win-back, availability...) | `asc_search_api` + `asc_describe_operation` for the exact body, then `asc_prepare_change`; several dependent steps: `asc_prepare_plan` |

Never work around a refusal: not by calling `asc_call` with a write, and not by re-preparing different values after the owner approved a different preview.

### Tiers (enforced by the server, not by this text)

- **Tier 1 (may run without a prompt; tell the owner afterwards):** TestFlight notes; text, settings, build choice and App Review details of a *draft* version; creating a new draft version; adding screenshots to a draft.
- **Tier 2 (preview, then the owner's explicit "yes", every time):** submitting, cancelling, phased release actions, releasing, anything on a live version, public replies, and **every subscription or price change** (it changes what customers pay).
- **Tier 3 (blocked, no ticket):** every delete except removing a single screenshot of a draft version (Tier 2, and the server proves the version is a draft); users and invitations, API keys, certificates, profiles, devices, bundle IDs.

Building or listing these tools is not permission to use them: a real submit, price change or release needs the owner's explicit request for that release.

### Submitting: what to say

State, from the preview: the version and build, the locales, and whether it will release **automatically after approval** (`AFTER_APPROVAL`) or wait for the owner (`MANUAL`). Apple has no all-or-nothing: if a plan fails midway, report exactly which steps took effect and read the current state before anything is retried.

### Money changes

Show the per-territory table (old, new, currency, percent), the start date, and whether existing subscribers keep their price. Never apply a price change inferred from a vague request: ask for the exact amount and scope (one territory or all).

### The kill switch

Writes are OFF unless the config file has `"writesEnabled": true`. If an apply is refused for that reason, tell the owner how to turn it on; do not look for another way.

## Known gaps (console only, per Apple's published API spec)

Creating a brand-new app record, App Privacy "nutrition label" answers, and the Paid Apps agreement / tax / banking. Deleting is blocked by design (except draft screenshots). Say it is a gap and tell the owner plainly; do not try to drive a browser. See `COVERAGE.md`.

## Habits

1. **Build numbers come from the owner's build system** (for example EAS or Xcode Cloud). Check the version is not already live (`asc_release_overview`) before a build. This plugin reads and attaches builds; it does not upload them.
2. **Times are shown in the configured time zone** (`timezone` in the config file; default: the computer's). Never show raw offsets.
3. **After any applied change**, read the resource back to confirm, and tell the owner the audit log has the before and after.
