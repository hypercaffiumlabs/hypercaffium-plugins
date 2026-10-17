---
description: Check Google Cloud is connected, say which projects are live, and choose what the plugin may change, grouped by risk level
disable-model-invocation: true
allowed-tools: ["mcp__plugin_hypercaffium-google-oauth_oauth__google_check_setup", "mcp__plugin_hypercaffium-google-oauth_oauth__google_settings", "mcp__plugin_hypercaffium-google-oauth_oauth__google_save_settings", "mcp__plugin_hypercaffium-google-oauth_oauth__google_list_projects", "mcp__kapture__list_tabs", "AskUserQuestion"]
---

Walk the owner through setting up the hypercaffium-google-oauth plugin. Plain English, short steps, no jargon. The owner may be a beginner.

1. Call `google_check_setup` to see the current state.

2. **Google Cloud connection.** The plugin uses the `gcloud` program (the Google Cloud command line tool) that is already signed in on this computer.
   - If `gcloud.problem` says gcloud was not found, explain it is a free program from Google and give the install page from the message (https://cloud.google.com/sdk/docs/install). Normal installs are found automatically. Only if it is installed somewhere unusual, tell the owner they can add a `gcloudPath` line to the settings file by hand (`~/.claude-plugins/hypercaffium-google-oauth.json`). It cannot be set from this chat.
   - If gcloud is not signed in, ask the owner to open a terminal window and run `gcloud auth login`, then call `google_check_setup` again.
   - Show which Google account gcloud uses. Ask whether it is the right one, and if so save it as `expectedAccount` so the plugin warns if it ever changes.

3. **Live projects.** A live project is one that real people sign in to. Changes there get an extra before and after warning and their own switch. Call `google_list_projects`, show the projects in plain English, and ask which (if any) are live. Save them with `google_save_settings` (`liveProjects`). From chat you can only add live projects; to remove one, edit the settings file by hand (`~/.claude-plugins/hypercaffium-google-oauth.json`, the `liveProjects` list).

4. **Access menu.** Show the switches grouped by risk, using the labels and help text from `google_settings`. Ask with AskUserQuestion, one multi-select question per risk level (Low, Medium, High), each option being one feature with its help text and its current state (on/off) in the description. Ask the owner to tick the ones they want ON. If the owner prefers, ask in plain text instead.
   - Then ask whether the **writes master switch** should be on (changes possible, each one previewed and confirmed) or off (read-only).
   - Save the choices with one `google_save_settings` call: every Low, Medium and High feature as true or false, plus `writesEnabled`.

5. **Critical features** (removing scopes, deleting clients, moving an app back to Testing). Show their current state and explain they start off. They can NOT be switched on from this chat: give the owner the exact terminal command from `criticalSettings` (it looks like `node "<plugin folder>/server/dist/setup.mjs"`) and explain they must open a terminal window themselves and run it there. If a critical feature is on and the owner wants it off, switch it off with `google_save_settings`.

6. **Browser check.** Some steps happen in the Google Cloud console, driven through the Kapture browser extension. Call Kapture `list_tabs`. If it works, say the browser is connected. If it fails, explain Kapture is not connected: the plugin still works, but console steps will come back as numbered manual steps for the owner to do by hand.

7. Finish with a short summary of what is on and off, and tell the owner to restart Claude Code so the plugin's tools match the new settings.

Rules:
- Only save what the owner chose in this conversation. Never switch on a critical feature, and never edit the settings file directly.
- No em dashes.
