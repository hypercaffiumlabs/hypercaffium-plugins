---
description: Connect your Google Play Console account and choose what the plugin may change, grouped by risk level
disable-model-invocation: true
allowed-tools: ["mcp__plugin_hypercaffium-play_play__play_settings", "mcp__plugin_hypercaffium-play_play__play_save_settings", "mcp__plugin_hypercaffium-play_play__play_check_setup", "AskUserQuestion"]
---

Walk the owner through setting up the hypercaffium-play plugin. Plain English, short steps, no jargon. The owner may be a beginner.

1. Call `play_settings` to see the current state.

2. **Account connection.** If `credentialsProblems` is not empty, help the owner create and enter a Google service account:
   - In Google Cloud Console: create (or pick) a project, enable the **Google Play Android Developer API**, then IAM and Admin > Service Accounts > create one and add a **JSON key**. Suggest keeping the file in a folder such as `C:\Users\<name>\GoogleKeys\` or `~/GoogleKeys/`.
   - In Play Console: Users and permissions > Invite new users > the service account's email. Grant app permissions for the app, starting with the least needed (viewing app information is enough to read). Remind them that Play asks "Are you sure?" after Save, and nothing is saved until they click Yes.
   - Ask for the full path to the JSON key file, the app's package name (for example com.example.app), and their time zone if it differs from this computer's.
   - Optional: if they want the team tools, ask for their developer account ID (the long number after /developers/ in the Play Console web address) and save it as developerId.
   - Save them with `play_save_settings` (it escapes paths correctly). Never ask for or display the contents of the key file.
   - Run `play_check_setup` and confirm Google accepted the key. A new service account can take up to a day to start working; if it fails, explain the problem it reports.

3. **Access menu.** Show the switches grouped by risk, using the labels and help text from `play_settings`. Ask with AskUserQuestion, one multi-select question per risk level (Low, Medium, High), each option being one feature with its help text and its current state (on/off) in the description. Ask the owner to tick the ones they want ON. If the owner prefers, ask in plain text instead.
   - Then ask whether the **writes master switch** should be on (changes possible, each one previewed and confirmed) or off (read-only).
   - Save the choices with one `play_save_settings` call: every Low, Medium and High feature as true or false, plus `writesEnabled`.

4. **Critical features** (users and permissions, signing keys, refunds and orders). Show their current state and explain they start off. They can NOT be switched on from this chat: give the owner the exact terminal command from `criticalSettings` and explain they must open a terminal window themselves and run it there. If a critical feature is on and the owner wants it off, switch it off with `play_save_settings`.

5. Finish with a short summary of what is on and off, and tell the owner to restart Claude Code so the plugin's tools match the new settings.

Rules:
- Only save what the owner chose in this conversation. Never switch on a critical feature, and never edit the settings file directly.
- No em dashes.
