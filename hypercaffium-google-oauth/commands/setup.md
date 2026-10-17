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

6. **Browser check (Kapture, strongly recommended).** About half of the setup happens on Google Cloud console pages that have no API. Kapture is the free companion that lets Claude do those steps in the owner's browser and check each one. It is a Chrome extension plus a small connector, not a Claude Code plugin. Use the `kapture` part of the `google_check_setup` result (`why`, `install`, `connect`) for the exact wording and steps; do not make up other steps.
   - **Kapture tools not available** (there is no Kapture `list_tabs` tool in this session): Kapture is not installed. Say plainly that it is strongly recommended and why, then give the `install` steps as a numbered list, followed by the `connect` steps. Mention that the owner can run `/hypercaffium-google-oauth:setup` again after restarting to confirm it works.
   - **`list_tabs` fails or shows no connected tab:** Kapture is installed but the browser is not connected. Give the `connect` steps, then call `list_tabs` once more after the owner says it is done.
   - **`list_tabs` works:** say the browser is connected, and pass on the tip to keep the Google Cloud tab in front while Claude works.
   - Whatever the result, the plugin still works without Kapture: console steps then come back as numbered manual steps, and the health check reports console items as "not checked". Say this once, after the recommendation, not instead of it.

7. Finish with a short summary of what is on and off, and tell the owner to restart Claude Code so the plugin's tools match the new settings.

Rules:
- Only save what the owner chose in this conversation. Never switch on a critical feature, and never edit the settings file directly.
- No em dashes.
