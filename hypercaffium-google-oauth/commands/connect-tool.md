---
description: Set up Google sign-in for a tool end to end (project, APIs, sign-in app, client file, accounts), then check it
argument-hint: <recipe> e.g. mcp-google-workspace
disable-model-invocation: true
allowed-tools: ["mcp__plugin_hypercaffium-google-oauth_oauth__google_check_setup", "mcp__plugin_hypercaffium-google-oauth_oauth__google_settings", "mcp__plugin_hypercaffium-google-oauth_oauth__google_list_projects", "mcp__plugin_hypercaffium-google-oauth_oauth__google_list_organizations", "mcp__plugin_hypercaffium-google-oauth_oauth__google_project_status", "mcp__plugin_hypercaffium-google-oauth_oauth__google_list_recipes", "mcp__plugin_hypercaffium-google-oauth_oauth__google_console_page", "mcp__plugin_hypercaffium-google-oauth_oauth__google_prepare_change", "mcp__plugin_hypercaffium-google-oauth_oauth__google_record_console_result", "mcp__plugin_hypercaffium-google-oauth_oauth__google_check_accounts", "mcp__plugin_hypercaffium-google-oauth_oauth__google_evaluate_console", "mcp__kapture__list_tabs", "mcp__kapture__new_tab", "mcp__kapture__navigate", "mcp__kapture__dom", "mcp__kapture__elements", "mcp__kapture__screenshot", "mcp__kapture__scroll"]
---

Set up Google sign-in for a tool, from nothing to "every account signed in and the app in production". The recipe is `$ARGUMENTS` (if empty, call `google_list_recipes`, show the choices in plain English and ask). Plain English, short steps. The owner may be a beginner. Follow the google-safety-rules skill for every change: prepare, explain, wait for a clear yes, apply, record.

Before starting, call `google_check_setup`. If writes are off or gcloud is not ready, say so and point to `/hypercaffium-google-oauth:setup`. Tell the owner which steps use the browser (Kapture) before you start them.

1. **Project.** Call `google_list_projects` and ask which project to use. If the owner wants a new one, call `google_list_organizations` and ask where it should live (an organization, a folder id, or on its own), then run prepare, explain, yes, apply with action `create_project` (`projectId` is the new id, params `{"name": "...", "organization": "..."}` or `{"folder": "..."}`). Say that no billing is linked and the id can never be changed. Then call `google_project_status`. If it is marked live, say so clearly: real users sign in with it, and every change will be shown before and after.

2. **APIs.** For each API in the recipe that is not already enabled, run prepare, explain, yes, apply with action `enable_api` (`{"api": "<api>"}`). No browser needed.

3. **Read the console first.** With Kapture, read the pages overview, branding, audience, scopes and clients (use `google_console_page` for each address and what to look at). Report in plain English what is already set, so nothing is changed that does not need to be. Pass what you saw to `google_evaluate_console` to see what is still missing.

4. **Sign-in app, one change at a time** (console steps, done with Kapture). For each one that is missing: `google_prepare_change`, explain, wait for yes, `google_apply_change` (it returns the console plan), do the plan in the browser (read the page, act, read it again), then `google_record_console_result` with what you now see. When you prepare a console action, pass `currentObserved` in `params`: what you just read on the page, using the same keys as `consolePlan.expected`, so the preview and any live-project warning show the real before.
   - Params per action: `enable_api` {api}; `create_project` {name?, organization? or folder?} (projectId is the new id); `add_scopes` and `remove_scopes` {scopes}; `set_branding` {fields: {appName, supportEmail, homepage, privacyPolicy, termsOfService, developerEmail}}; `create_client` {recipe, name, clientType?, allowOverwrite?}; `sign_in_account` {recipe, email, accountType?, note?}; `add_test_user` {email}; `set_user_type` {userType}; `delete_client` {name}; `save_recipe` {recipe}.
   - `set_branding` (app name, support email, developer contact).
   - `add_scopes` with the recipe's scopes.
   - `create_client` with the recipe's client type. Google shows the client file download once. Ask the owner to download it in the browser, then pass the full path of the file in their Downloads folder as `downloadedFile` when recording. The plugin installs it where the recipe needs it, only if what you observed matches the plan. Never open, read or show that file. If the recipe's client file already exists, preparing is refused with a plain message. Explain that creating a new client would replace the existing file; only if the owner agrees, prepare again with `allowOverwrite: true`, which is a critical change needing `google_apply_sensitive_change`.
   - `publish`, so logins do not expire after 7 days. Before it, explain in plain terms if the scopes are sensitive or restricted (Gmail is): the app will work for the owner but Google shows an "unverified app" warning and caps the number of users. Google's verification review is separate and not done by this plugin.

5. **Accounts.** Ask which Google accounts to sign in. For each email: prepare, explain, yes, apply with action `sign_in_account` (`recipe`, `email`, optional `accountType` and `note`). Tell the owner a browser window may open for them to approve the login.
   - Accounts that signed in while the app was still in Testing keep the 7-day limit even after publishing. After publishing in this run, offer to sign in again every account that was signed in before the publish (or that the owner says was signed in while the app was in Testing). Explain that logins made in Testing still expire after 7 days even though they refresh fine today.

6. **Final check.** Do everything in `/hypercaffium-google-oauth:check` for this recipe and project and give the plain-English verdict per item. Do not say "published" or "healthy" unless this run showed it.

Rules:
- Never read, print or paste a client secret, token or key file.
- If a page does not look like the plan, stop and tell the owner what you see. Do not click anything outside the plan.
- If Kapture is not connected, give the manual numbered steps from the plan and ask the owner to confirm what they see. Do not claim success without observing it.
- No em dashes.
