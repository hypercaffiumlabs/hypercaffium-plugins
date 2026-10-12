# hypercaffium-apple

A [Claude Code](https://claude.com/claude-code) plugin that lets Claude run your **App Store Connect** work through Apple's official API: check release status, edit release notes, attach builds, submit for review, manage TestFlight, reply to reviews and change subscription prices.

Every change is **previewed, confirmed and logged**. Nothing happens without you seeing the exact before and after.

> Status: pre-release. Not affiliated with or endorsed by Apple. "App Store Connect" is an Apple trademark.

## What it can do

| Area | Tools |
|---|---|
| **Release** | `asc_release_overview` (with a pre-flight checklist), `asc_set_release_notes`, `asc_edit_listing`, `asc_attach_build`, `asc_create_version`, `asc_upload_screenshots`, `asc_clear_screenshots`, `asc_submit_for_review`, `asc_cancel_submission`, `asc_phased_release`, `asc_release_version` |
| **Subscriptions** | `asc_subscription_overview`, `asc_subscription_prices`, `asc_find_price_point`, `asc_set_subscription_price`, `asc_edit_subscription`, `asc_edit_subscription_localization`, `asc_create_intro_offer` |
| **Reviews** | `asc_review_inbox`, `asc_reply_to_review` |
| **App Review & info** | `asc_edit_review_details`, `asc_edit_app_info` |
| **TestFlight** | `asc_testflight_overview`, `asc_testflight_set_notes`, `asc_testflight_add_tester`, `asc_testflight_remove_tester`, `asc_testflight_add_build_to_group`, `asc_testflight_submit_for_review`, `asc_testflight_expire_build` |
| **Media** | `asc_upload_screenshots`, `asc_upload_app_previews` (videos), `asc_clear_screenshots`; both uploads also work on custom product pages |
| **Offers** | `asc_offer_codes_overview`, `asc_create_offer_code`, `asc_generate_offer_codes`, `asc_set_offer_code_active`, `asc_create_promotional_offer`, `asc_create_win_back_offer` |
| **Custom product pages** | `asc_custom_pages_overview`, `asc_create_custom_page`, `asc_edit_custom_page_text`, `asc_submit_custom_page` |
| **Everything else in Apple's API** | `asc_search_api`, `asc_describe_operation`, `asc_call` (reads), `asc_prepare_change` / `asc_prepare_plan` (writes) |
| **Monitoring** | `asc_check_changes`, `asc_audit_log`, plus the commands `/hypercaffium-apple:release-status` and `/hypercaffium-apple:check-changes` (App Store, and Google Play too when hypercaffium-play is installed) |

It indexes Apple's full OpenAPI description (1,300+ operations), so anything the API offers is reachable. See [COVERAGE.md](COVERAGE.md) for what Apple's API does and does not cover.

## How changes stay safe

1. **Prepare, then apply.** A change tool returns an exact preview and a one-time ticket. Applying runs exactly that ticket, once.
2. **Tiers, enforced by the server (not just by instructions):**
   - **Tier 1** can run without a prompt: low-risk edits to a version that is still a draft.
   - **Tier 2** needs your explicit approval: submissions, anything on a live version, public replies, anything that changes what customers pay.
   - **Tier 3** is blocked: deletes (except draft screenshots and taking testers out of a TestFlight group), API keys, and any area switched off in your access settings.
3. **Kill switch.** Writes are **off by default**. Turn them on with `"writesEnabled": true` in the config file; remove it to go read-only again.
4. **Audit log.** Every change is recorded with its before and after values. Secrets and passwords are never logged.
5. **Everything is validated** against Apple's request schemas before it is sent.

## Security model and its limits

- **What stops a bad change:** the server classifies every change into a tier and refuses blocked ones before anything is sent. This is code, not just instructions to the AI.
- **Settings:** the settings file is yours. Claude could edit it like any file, so the terminal-only rule for critical areas is a strong lock against mistakes, not against someone who controls your computer.
- **What a "yes" really is:** the plugin cannot see who is approving. A Tier 2 change runs when the apply tool is called with a valid ticket, so the human gate is **Claude Code's own permission prompt** for that tool. Do not add `*_apply_change` to your always-allow list. It is safe to always-allow only `*_apply_safe_change`, which refuses anything above Tier 1.
- **Local trust:** anything that can run code as you can already read your key file and call Apple's or Google's API directly. The plugin does not defend against a compromised computer. Keep the key file readable only by you.
- **Least privilege:** give the key or service account only the roles you need (App Manager, not Admin; the Play permissions in the table above). Revoke it in the store console if you stop using the plugin.
- **Credentials go to one place:** the bearer token is only ever sent to Apple's or Google's own API host (enforced in code).
- **Image uploads read local files:** only `.png` and `.jpg` files that really are images (checked by content), within the store's size limits, and the preview lists every file name before you approve.
- **Nothing phones home:** there is no telemetry. Logs stay in `~/.claude-plugins/`.

## Install

Requires [Claude Code](https://claude.com/claude-code) and Node.js 20 or newer.

```
/plugin marketplace add hypercaffiumlabs/hypercaffium-plugins
/plugin install hypercaffium-apple@hypercaffium
```

### Both stores

If you publish on both, install both plugins:

```
/plugin marketplace add hypercaffiumlabs/hypercaffium-plugins
/plugin install hypercaffium-apple@hypercaffium
/plugin install hypercaffium-play@hypercaffium
```

With both installed, `/hypercaffium-apple:release-status` and `/hypercaffium-apple:check-changes` report on both stores in one answer. The order you install them in does not matter; restart Claude Code once after installing a plugin.

## Access settings

Run **`/hypercaffium-apple:setup`** after installing. It connects your account (no hand-edited JSON) and shows a menu of what the plugin may change, grouped by risk:

| Risk | Areas | Default |
|---|---|---|
| Low | TestFlight | On |
| Medium | Store listing, review replies, marketing pages | On |
| High | Releases, prices and offers, uploading app files, everything else in the API | On |
| Critical | Users and permissions, signing keys (certificates, profiles, bundle IDs, devices) | **Off** |

Switched-off areas are refused by the server for every route, not just hidden. Switching something off takes effect at once; restart Claude Code after changes so the dedicated tools match.

**Critical areas can only be switched on in a terminal menu**, which needs a real keyboard, so Claude cannot switch them on for you. Open a terminal window yourself and run:

```
node "<plugin folder>/server/dist/setup.mjs"
```

(`/hypercaffium-apple:setup` prints the exact path.) Critical changes are applied through a separate approval tool, `asc_apply_sensitive_change`, so allowing `asc_apply_change` can never cover them.

## Set up

The easiest way is **`/hypercaffium-apple:setup`**, which asks for these details and writes the settings file for you. To do it by hand:

1. In App Store Connect: **Users and Access > Integrations > App Store Connect API**.
2. Note the **Issuer ID** at the top of the page.
3. Create a key with the **App Manager** role (not Admin), note its **Key ID**, and download the `.p8` file (Apple allows this once).
4. Create `~/.claude-plugins/hypercaffium-apple.json` (on Windows: `C:\Users\<you>\.claude-plugins\`):

```json
{
  "keyId": "ABC123DEFG",
  "issuerId": "00000000-0000-0000-0000-000000000000",
  "keyPath": "C:\\Users\\you\\keys\\AuthKey_ABC123DEFG.p8",
  "timezone": "America/New_York",
  "writesEnabled": false
}
```

The file holds only IDs and a path, never the key itself. On Windows every backslash in a path must be doubled. `timezone` is optional (default: this computer's). Environment variables `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_PATH`, `ASC_WRITES_ENABLED` and `HYPERCAFFIUM_TIMEZONE` override the file.

Then ask Claude to run `asc_check_setup`.

## Background watcher (optional, Windows)

`server/dist/watch.mjs` can run every 30 minutes as a scheduled task and show a Windows notification **only when something changed** on the App Store: versions, builds, review submissions and new reviews. It only reads. If the App Store cannot be read (an expired key, an outage) it tells you at most once a day.

- Log: `~/.claude-plugins/watch-apple.log`. Latest result: `~/.claude-plugins/state/watch-apple-latest.json`.
- Test the notification: `node <plugin folder>\server\dist\watch.mjs --test-toast`.

Register it (PowerShell). The task looks up the newest installed version each time it runs, so it keeps working after plugin updates:

```powershell
$plugin = 'hypercaffium-apple'
$run = "`$d = Get-ChildItem '$HOME\.claude\plugins\cache\hypercaffium\$plugin' -Directory | Sort-Object { [version]`$_.Name } | Select-Object -Last 1; & node (Join-Path `$d.FullName 'server\dist\watch.mjs')"
$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($run))
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument "--headless powershell.exe -NoProfile -NonInteractive -EncodedCommand $enc"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName "Hypercaffium Apple Watch" -Action $action -Trigger $trigger
```

Pause: `Disable-ScheduledTask -TaskName "Hypercaffium Apple Watch"`. Remove: `Unregister-ScheduledTask -TaskName "Hypercaffium Apple Watch" -Confirm:$false`.

## Builds

This plugin does not upload builds. Use your own pipeline (EAS, Xcode Cloud, fastlane, Xcode). It reads and attaches builds once they have finished processing.

## Development

```
cd server
npm install
npm test            # offline test suite
npm run build       # bundles server/dist/server.mjs and server/dist/watch.mjs (committed so installs need no npm)
node ../scripts/build-spec-index.js   # refresh the bundled API index from Apple
```

## License

MIT. See [LICENSE](LICENSE).
