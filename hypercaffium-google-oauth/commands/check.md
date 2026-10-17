---
description: Is your Google sign-in setup healthy? Checks the saved logins and the Google Cloud console. Add --selftest to test that the console pages still look the way the plugin expects.
argument-hint: <recipe> [project] | --selftest [project]
allowed-tools: ["mcp__plugin_hypercaffium-google-oauth_oauth__google_check_setup", "mcp__plugin_hypercaffium-google-oauth_oauth__google_list_projects", "mcp__plugin_hypercaffium-google-oauth_oauth__google_project_status", "mcp__plugin_hypercaffium-google-oauth_oauth__google_list_recipes", "mcp__plugin_hypercaffium-google-oauth_oauth__google_console_page", "mcp__plugin_hypercaffium-google-oauth_oauth__google_check_accounts", "mcp__plugin_hypercaffium-google-oauth_oauth__google_evaluate_console", "mcp__kapture__list_tabs", "mcp__kapture__new_tab", "mcp__kapture__navigate", "mcp__kapture__dom", "mcp__kapture__elements", "mcp__kapture__screenshot", "mcp__kapture__scroll"]
---

Tell the owner, from evidence, whether their Google sign-in setup is healthy. Plain English. This command only reads; it never changes anything. Arguments: `$ARGUMENTS`.

## Normal check: `<recipe> [project]`

1. If the recipe or project is missing, call `google_list_recipes` / `google_list_projects` and ask.
2. Call `google_check_accounts` for the recipe. It reports, per account, whether the saved login still works and which scopes it really has.
3. Call Kapture `list_tabs`. If Kapture is connected, read the console pages with Kapture (read only, never click anything that changes data): for each page use `google_console_page` to get the address and what to read (publishing status, user type, scopes, clients, test users, verification status). Build one observation, `{ publishingStatus, userType, scopes[], clients[{name, type}], testUsers, verificationStatus }`, using only what you really saw, and call `google_evaluate_console`.
4. If Kapture is not connected, report every console item as **not checked** (never as ok) and say how to check it: connect Kapture, or open the addresses from `google_project_status` by hand.
5. Give a verdict per item: each account's login, publishing status, scopes needed vs configured, OAuth client present. Mark what is fine, what needs action (for example "signed in while in Testing, will expire in 7 days: sign in again") and what could not be checked. Lead with anything that needs action.

## Self-test: `--selftest [project]`

Google sometimes moves or renames buttons and labels. This test finds that before a real change fails.

1. Pick the project (ask if not given).
2. For every page (overview, branding, audience, clients, scopes, verification) call `google_console_page`, open the address with Kapture and read the page. Look for each text in the returned `labels` list (pages with an empty list only need to load). Read only. Do not click anything that changes data.
3. Report each label from `labels` that you could not find on its page, plainly (for example "branding: could not find 'Application privacy policy link'"). If everything was found, say so.
4. If Kapture is not connected, say the self-test could not run.
5. Nothing is changed and nothing is recorded as a change.

Rules:
- Only report values you actually observed. A value you could not see is "not checked".
- Never show a token, secret or key.
- No em dashes.
