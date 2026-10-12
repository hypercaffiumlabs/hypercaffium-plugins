---
description: Connect your App Store Connect account and choose what the plugin may change, grouped by risk level
disable-model-invocation: true
allowed-tools: ["mcp__plugin_hypercaffium-apple_asc__asc_settings", "mcp__plugin_hypercaffium-apple_asc__asc_save_settings", "mcp__plugin_hypercaffium-apple_asc__asc_check_setup", "AskUserQuestion"]
---

Walk the owner through setting up the hypercaffium-apple plugin. Plain English, short steps, no jargon. The owner may be a beginner.

1. Call `asc_settings` to see the current state.

2. **Account connection.** If `credentialsProblems` is not empty, help the owner create and enter an App Store Connect API key:
   - In App Store Connect: Users and Access > Integrations > App Store Connect API.
   - The **Issuer ID** is at the top of that page.
   - Create a key with the **App Manager** role (not Admin). Note its **Key ID** and download the `.p8` file (Apple allows this download only once). Suggest keeping it in a folder such as `C:\Users\<name>\AppleKeys\` or `~/AppleKeys/`.
   - Ask for the Key ID, Issuer ID and the full path to the `.p8` file, and their time zone if it differs from this computer's.
   - Save them with `asc_save_settings` (it escapes paths correctly). Never ask for or display the contents of the key file.
   - Run `asc_check_setup` and confirm Apple accepted the key. If not, explain the problem it reports.

3. **Access menu.** Show the switches grouped by risk, using the labels and help text from `asc_settings`. Ask with AskUserQuestion, one multi-select question per risk level (Low, Medium, High), each option being one feature with its help text and its current state (on/off) in the description. Ask the owner to tick the ones they want ON. If the owner prefers, ask in plain text instead.
   - Then ask whether the **writes master switch** should be on (changes possible, each one previewed and confirmed) or off (read-only).
   - Save the choices with one `asc_save_settings` call: every Low, Medium and High feature as true or false, plus `writesEnabled`.

4. **Critical features** (users and permissions, signing keys). Show their current state and explain they start off. They can NOT be switched on from this chat: give the owner the exact terminal command from `criticalSettings` and explain they must open a terminal window themselves and run it there. If a critical feature is on and the owner wants it off, switch it off with `asc_save_settings`.

5. Finish with a short summary of what is on and off, and tell the owner to restart Claude Code so the plugin's tools match the new settings.

Rules:
- Only save what the owner chose in this conversation. Never switch on a critical feature, and never edit the settings file directly.
- No em dashes.
