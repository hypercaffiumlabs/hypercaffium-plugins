---
name: google-safety-rules
description: Use when working with Google sign-in setup, Google Cloud projects, enabling Google APIs, the Google Auth Platform (branding, scopes, audience, publishing, OAuth clients), signing in Google accounts for a tool, or checking whether a Google sign-in is healthy. Explains the google_ tools and the mandatory prepare-then-apply protocol, including the Kapture rules for console steps.
version: 0.2.1
---

# Google sign-in setup: how to use these tools safely

Explain what you are about to do in plain English before any change, and wait for an explicit "yes" from the owner.

## Reading (always safe)

| Tool | Use it for |
|---|---|
| `google_check_setup` | First step if anything fails: is gcloud found and signed in, which account, are writes on |
| `google_settings` | The settings: writes switch, live projects, expected account, feature switches |
| `google_list_projects`, `google_project_status` | Projects you can see; one project's enabled APIs, live flag and console page addresses |
| `google_list_recipes` | The tools this plugin knows how to set up (recipes) |
| `google_console_page` | The address of one console page and what to read on it |
| `google_check_accounts` | Each saved login against Google: still valid, real scopes, missing scopes. Never shows tokens |
| `google_evaluate_console` | Pass what you observed in the console and get a verdict per check |
| `google_audit_log` | The activity log |

## Changing things: ALWAYS two steps (three for console changes)

1. **`google_prepare_change`** with `action` and `params`. It changes nothing. It returns the exact change, the current value next to the new value, a tier, and a one-time **ticket** (valid 10 minutes).
   Params per action: `enable_api` {api}; `create_project` {name?, organization? or folder?} with `projectId` set to the NEW id; `add_scopes` and `remove_scopes` {scopes}; `set_branding` {fields: {appName, supportEmail, homepage, privacyPolicy, termsOfService, developerEmail}}; `create_client` {recipe, name, clientType?, allowOverwrite?}; `sign_in_account` {recipe, email, accountType?, note?}; `add_test_user` {email}; `set_user_type` {userType}; `delete_client` {name}; `save_recipe` {recipe}. For console actions also pass `currentObserved`: what you just read on the page, using the keys in `consolePlan.expected`, so the preview and the live-project warning show the real "before". If the tool already has a client file, `create_client` is refused unless you prepare again with `allowOverwrite: true` (a critical change).
   Actions: `enable_api`, `create_project`, `add_test_user`, `set_branding`, `add_scopes`, `create_client`, `sign_in_account`, `publish`, `set_user_type`, `remove_scopes`, `delete_client`, `back_to_testing`, `save_recipe`. `projectId` is optional only for `save_recipe` (saving your own recipe is a ticketed change too).
2. Explain the preview in plain English and wait for an explicit yes.
3. **`google_apply_change`** with the ticket. `enable_api`, `sign_in_account` and `save_recipe` run right away. Console actions return a **console plan**: you then perform it with Kapture and finish with step 4.
4. **`google_record_console_result`** with the ticket and what the page now shows, using the keys in `consolePlan.expected` (for example `publishingStatus`, `scopes[]`, `clients[{name, type}]`, `testUsers`, `userType`, `verificationStatus`; branding records need the branding keys). For `create_client`, also pass `downloadedFile` (the client JSON in the owner's Downloads folder); the plugin installs it only when the observation matches. The result says match or mismatch. Report a mismatch as a failure, never smooth it over.

Destructive actions (`remove_scopes`, `delete_client`, `back_to_testing`) and `create_client` with `allowOverwrite` can only be applied with **`google_apply_sensitive_change`**. Before using it, say plainly what could go wrong and get an explicit yes for that exact change.

Never work around a refusal and never re-prepare with different values after the owner approved a different preview.

## Kapture rules (console steps)

The Google Auth Platform pages have no public API, so Claude does them in the browser with Kapture:

1. Say you are about to use the browser.
2. Open the page and **read it first**. Confirm it loaded and you are signed in to the right Google account.
3. Do only the steps in the console plan. **Never click anything outside the plan.**
4. **Read the page again** and report what you now see. Never assume it worked.
5. If the page does not look like the plan (a label is missing, a different screen, a warning), **stop and tell the owner**. Do not improvise.
6. **Do not trigger browser dialogs** (alert, confirm, prompt, file pickers) that Kapture cannot handle. If Google opens one, stop and ask the owner to handle it.
7. If Kapture is not connected, give the numbered manual steps and ask the owner to confirm what they see. Report console items as "not checked" until observed.

## Secrets

- Never read, print, paste or summarise a client secret, access token, refresh token or the contents of a client file. The client file goes straight from Downloads to the tool's own folder, at the client file path given in the recipe.
- If a secret appears on screen (Google shows it once), do not copy it. Tell the owner to download the file themselves.
- Audit entries and tool output contain no secrets. Do not add any.

## Live projects

A project marked live has real users. Tell the owner, in these words or close to them: "This is a LIVE project: real people sign in with it. Here is exactly what changes, from what to what." Show the before and after and get a clear yes for that change. Live changes need the "Changes on live projects" switch on; if it is off, the change is refused. Do not look for another way.

## Tiers and switches (enforced by the server)

- **Refused (no ticket):** a feature switched off in settings, or a live project while "Changes on live projects" is off.
- **Preview, then the owner's yes:** every change. There is no automatic tier.
- **Critical (terminal switch only):** removing or resetting sign-in setup (`remove_scopes`, `delete_client`, `back_to_testing`). Needs `google_apply_sensitive_change`.
- Feature groups: Low (APIs, test users), Medium (branding, scopes, clients, account sign-ins), High (publishing, live projects), Critical (destructive).
- If a change is refused because a feature is off, tell the owner which switch it is and that `/hypercaffium-google-oauth:setup` changes it.
- Never call `google_save_settings` unless the owner is choosing settings right now, and never edit the settings file. Critical features can only be switched on in the terminal menu. `gcloudPath` can only be set by editing the settings file by hand. A live project can be added from chat; to remove one, edit the settings file by hand (`~/.claude-plugins/hypercaffium-google-oauth.json`, the `liveProjects` list).

## The kill switch

Writes are OFF unless the settings have `"writesEnabled": true`. If `google_apply_change` says writes are off, tell the owner how to turn them on (`/hypercaffium-google-oauth:setup`); do not look for another way.

## Habits

1. **Say what is evidence.** Never say "published", "healthy" or "permanent login" unless this session read it from the console or Google.
2. **Publishing does not fix old logins.** Accounts signed in during Testing keep the 7-day limit. Offer to sign them in again after publishing.
3. **Gmail scopes are restricted.** An unverified production app works for its owner but shows an "unverified app" warning and has a user cap. Explain this before publishing; the plugin does not do Google's verification review.
4. **Button labels may change.** `/hypercaffium-google-oauth:check --selftest` finds renamed labels without changing anything.
5. **After any applied change**, confirm it by reading it back, and tell the owner the audit log has the record.
