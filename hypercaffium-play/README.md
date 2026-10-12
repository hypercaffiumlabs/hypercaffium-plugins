# hypercaffium-play

A [Claude Code](https://claude.com/claude-code) plugin that lets Claude manage **Google Play Console** through Google's official Play Developer API: release status, tracks and staged rollouts, store listing text and images, review replies and subscriptions.

Every change is **previewed, confirmed and logged**.

> Status: pre-release. Not affiliated with or endorsed by Google. "Google Play" is a Google trademark.

## What it can do

| Area | Tools |
|---|---|
| **Status** | `play_release_status`, `play_list_tracks`, `play_list_bundles`, `play_check_changes` |
| **Releases** | `play_set_release`, `play_rollout`, `play_promote_release`, `play_set_release_notes` |
| **Listing** | `play_edit_listing`, `play_upload_images` |
| **Reviews** | `play_list_reviews`, `play_reply_to_review` |
| **Subscriptions** | `play_subscription_overview` |
| **Everything else in Google's API** | `play_search_api`, `play_describe_method`, `play_call` (reads), `play_prepare_change` (writes) |
| **Audit** | `play_audit_log` |

See [COVERAGE.md](COVERAGE.md) for what the API does and does not cover (for example, creating an app and the content-rating questionnaire are console-only).

## How changes stay safe

1. **Prepare, then apply.** A change tool returns an exact preview and a one-time ticket; applying runs exactly that ticket once. Edit-based changes are committed together or not at all.
2. **Tiers, enforced by the server:** everything that changes your app needs your explicit approval; deletes, users, permission grants and purchase refunds are blocked.
3. **Kill switch.** Writes are **off by default** (`"writesEnabled": true` turns them on).
4. **Audit log.** Every change is recorded with before and after values.
5. **One open edit at a time.** Google keeps a single open edit per app, so the plugin never opens two at once.

## Security model and its limits

- **What stops a bad change:** the server classifies every change into a tier and refuses blocked ones before anything is sent. This is code, not just instructions to the AI.
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
/plugin install hypercaffium-play@hypercaffium
```

### Install all three

If you publish on both stores, the first command adds the Hypercaffium catalog and the other three install one plugin each:

```
/plugin marketplace add hypercaffiumlabs/hypercaffium-plugins
/plugin install hypercaffium-apple@hypercaffium
/plugin install hypercaffium-play@hypercaffium
/plugin install glue@hypercaffium
```

`glue` only adds commands that report on both stores at once. If you publish on one store only, skip it.

## Set up

1. In Google Cloud: **APIs & Services > Library**, enable **Google Play Android Developer API**.
2. **IAM & Admin > Service Accounts**: create a service account (no Google Cloud roles needed), then **Keys > Add key > JSON**.
3. In **Play Console > Users and permissions**, invite the service account's email with the permissions you want it to have. After you click **Save changes**, Play asks *"Are you sure you want to update the permissions of this user?"*: click **Yes**, or nothing is saved.
4. Create `~/.claude-plugins/hypercaffium-play.json`:

```json
{
  "serviceAccountKeyPath": "C:\\Users\\you\\keys\\play-service-account.json",
  "defaultPackageName": "com.example.yourapp",
  "timezone": "America/New_York",
  "writesEnabled": false
}
```

Environment variables `PLAY_SA_KEY_PATH`, `PLAY_PACKAGE_NAME`, `PLAY_WRITES_ENABLED` and `HYPERCAFFIUM_TIMEZONE` override the file. Then ask Claude to run `play_check_setup`.

### Permissions, least first

| To do this | Grant this Play Console permission |
|---|---|
| Read status, tracks, bundles | View app information, View app quality information |
| Releases and rollouts | Release to production..., Release apps to testing tracks, Manage testing tracks and edit tester lists |
| Listing text and images | Manage store presence |
| Reply to reviews | Reply to reviews |
| Subscriptions | Manage orders and subscriptions |

Google forces a few dependent permissions on automatically (for example "Manage policy declarations"). Grant only what you need, one at a time.

## Background watcher (optional, Windows)

`server/dist/watch.mjs` can run every 30 minutes as a scheduled task and show a Windows notification **only when something changed** on Google Play: new reviews. It only reads. If Google Play cannot be read (an expired key, an outage) it tells you at most once a day.

Reviews only, on purpose: reading tracks needs a Play "edit", and Google keeps one open edit per app, so a background job could disturb work you have open in the console. Ask for tracks on demand with `play_check_changes`.

- Log: `~/.claude-plugins/watch-google.log`. Latest result: `~/.claude-plugins/state/watch-google-latest.json`.
- Test the notification: `node <plugin folder>\server\dist\watch.mjs --test-toast`.

Register it (PowerShell). The task looks up the newest installed version each time it runs, so it keeps working after plugin updates:

```powershell
$plugin = 'hypercaffium-play'
$run = "`$d = Get-ChildItem '$HOME\.claude\plugins\cache\hypercaffium\$plugin' -Directory | Sort-Object { [version]`$_.Name } | Select-Object -Last 1; & node (Join-Path `$d.FullName 'server\dist\watch.mjs')"
$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($run))
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument "--headless powershell.exe -NoProfile -NonInteractive -EncodedCommand $enc"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName "Hypercaffium Play Watch" -Action $action -Trigger $trigger
```

Pause: `Disable-ScheduledTask -TaskName "Hypercaffium Play Watch"`. Remove: `Unregister-ScheduledTask -TaskName "Hypercaffium Play Watch" -Confirm:$false`.

## Builds

This plugin does not upload app bundles. Use your own pipeline (EAS, Gradle, fastlane). It checks that a version code exists before putting it on a track.

## Development

```
cd server
npm install
npm test
npm run build       # bundles server/dist/server.mjs and server/dist/watch.mjs (committed so installs need no npm)
node ../scripts/build-spec-index.js   # refresh the bundled API index from Google
```

## License

MIT. See [LICENSE](LICENSE).
