# hypercaffium-google-oauth

A [Claude Code](https://claude.com/claude-code) plugin that sets up and checks **Google sign-in** for any tool that reads Gmail, Calendar, Drive or other Google data (MCP servers, scripts, agents).

Such tools need a Google Cloud "sign-in app": a project with the right APIs on, a configured Google Auth Platform (branding, scopes, audience), an OAuth client, and a published app so logins do not expire after 7 days. This plugin walks through all of it and checks it afterwards.

Every change is **previewed, confirmed and logged**.

> Status: pre-release (0.2.0). Not affiliated with or endorsed by Google. "Google" and "Google Cloud" are Google trademarks.

## What it can do

| Area | How |
|---|---|
| **Projects and APIs** | List projects and organizations, create a new empty project (no billing linked), enable the APIs a tool needs. Uses your existing `gcloud` sign-in, no browser |
| **Sign-in app** | Branding, scopes, test users, audience, OAuth client, publish to production. Done in the Google Cloud console with the Kapture browser extension, one previewed step at a time |
| **Hand-off to the tool** | Installs the downloaded client file where the tool expects it, then signs in each Google account with the tool's own login command |
| **Health check** | Publishing status, scopes needed vs configured, clients present, and for each saved login the scopes it really has and whether it still works. Plain-English verdict per item |
| **Recipes** | A small file describing one tool (APIs, scopes, client type, login command, token location). `mcp-google-workspace` is built in; you can save your own |
| **Audit** | `google_audit_log` |

Commands: `/hypercaffium-google-oauth:setup`, `/hypercaffium-google-oauth:connect-tool <recipe>`, `/hypercaffium-google-oauth:check <recipe> [project]` (and `check --selftest`).

See [COVERAGE.md](COVERAGE.md) for what is automated and how.

## Requirements

- [Claude Code](https://claude.com/claude-code) and Node.js 20 or newer.
- The Google Cloud CLI, `gcloud`, installed and signed in (`gcloud auth login`). Install: https://cloud.google.com/sdk/docs/install. `/hypercaffium-google-oauth:setup` checks it.
- For automation of the console steps: the **Kapture** browser extension, connected to the browser where you are signed in to Google Cloud.
- **Without Kapture** everything still works: console steps come back as numbered manual steps with direct links, and the health check reports console items as "not checked" rather than guessing.

## The one limit

Google offers **no public API** for the Google Auth Platform screens a standard app uses: branding, publishing to production, Data Access scopes, or creating standard OAuth clients. (The old IAP OAuth Admin APIs were shut down in March 2026.) That is why these steps go through the browser. Creating projects, enabling APIs and listing projects do not need it.

## How changes stay safe

1. **Prepare, then apply.** A change tool returns an exact preview (current value next to new value) and a one-time ticket. Applying runs exactly that ticket once.
2. **Console steps are recorded.** After Claude performs a console step with Kapture, it reads the page again and reports what it sees to `google_record_console_result`. The server compares that with the plan; a mismatch is reported as a failure. A client file is only installed when the observation matches.
3. **Tiers, enforced by the server:** every change needs your explicit approval. Switched-off areas are refused. Changes to a project you marked **live** need their own switch and show an extra before/after warning.
4. **Critical changes** (removing scopes, deleting clients, moving an app back to Testing, overwriting a client file) are applied only through a separate tool, `google_apply_sensitive_change`, and the area starts off.
5. **Kill switch.** Writes are **off by default** (`"writesEnabled": true` turns them on).
6. **Audit log.** Every call is recorded in `~/.claude-plugins/audit/`. Entries never contain secrets.

## Security model and its limits

- **What stops a bad change:** the server classifies every change and refuses blocked ones before anything happens. This is code, not just instructions to the AI.
- **What a "yes" really is:** the plugin cannot see who is approving. A change runs when the apply tool is called with a valid ticket, so the human gate is **Claude Code's own permission prompt** for that tool. Do not add `*_apply_change` or `*_apply_sensitive_change` to your always-allow list.
- **Secrets:** the client file goes straight from your Downloads folder to the recipe's path. Its contents, and any token, never enter chat, logs or the repo. Claude is told never to read or copy a client secret shown on screen.
- **Settings:** the settings file is yours. Claude could edit it like any file, so the terminal-only rule for critical areas is a strong lock against mistakes, not against someone who controls your computer.
- **Local trust:** anything that can run code as you can already read your saved logins. The plugin does not defend against a compromised computer.
- **Unverified apps:** Gmail scopes are restricted by Google. An unverified production app works for its owner but shows an "unverified app" warning and has a lifetime user cap. The plugin explains this before publishing; it does not do Google's verification review.
- **Nothing phones home:** there is no telemetry. Logs stay in `~/.claude-plugins/`.

## Install

```
/plugin marketplace add hypercaffiumlabs/hypercaffium-plugins
/plugin install hypercaffium-google-oauth@hypercaffium
```

Restart Claude Code once after installing.

## Set up

Run **`/hypercaffium-google-oauth:setup`**. It checks gcloud and the browser extension, asks which projects are live, and shows a menu of what the plugin may change, grouped by risk:

| Risk | Areas | Default |
|---|---|---|
| Low | Turn on Google APIs, test users | On |
| Medium | Branding, scopes, sign-in clients, account sign-ins | On |
| High | Publishing to production, changes on live projects | On |
| Critical | Removing or resetting sign-in setup | **Off** |

**Critical areas can only be switched on in a terminal menu**, which needs a real keyboard, so Claude cannot switch them on for you. Open a terminal window yourself and run:

```
node "<plugin folder>/server/dist/setup.mjs"
```

(`/hypercaffium-google-oauth:setup` prints the exact path.) Writes start **off**; the setup command asks whether to turn them on.

Settings live in `~/.claude-plugins/hypercaffium-google-oauth.json`. `gcloudPath` can only be set by editing that file by hand; normal installs are found automatically. Chat can add a live project but not remove one: to remove it, edit the settings file by hand (`~/.claude-plugins/hypercaffium-google-oauth.json`, the `liveProjects` list).

## Using it

1. `/hypercaffium-google-oauth:connect-tool mcp-google-workspace` takes a tool from nothing to every account signed in and the app in production.
2. `/hypercaffium-google-oauth:check mcp-google-workspace <project>` answers "is my Google sign-in healthy?" from evidence.
3. `/hypercaffium-google-oauth:check --selftest <project>` reads each console page without changing anything and reports labels it could not find, in case Google renamed something.

Logins created while an app is in Testing expire after 7 days, and publishing does not extend logins already issued. After publishing, `connect-tool` offers to sign those accounts in again.

## Recipes

A recipe is a small JSON file for one tool: name, the APIs and scopes it needs, the OAuth client type, where the client file goes, how to sign in one account (a command with an `{email}` placeholder), and where saved logins live. One recipe is built in:

| Recipe | For |
|---|---|
| `mcp-google-workspace` | Multi-account Gmail and Calendar MCP server |

Your own recipes are saved with a normal previewed change (`save_recipe`) into `~/.claude-plugins/hypercaffium-google-oauth/recipes/`, never into the plugin folder. Built-in names cannot be overwritten.

## Development

```
cd server
npm install
npm test
npm run build       # bundles server/dist (committed so installs need no npm)
```

## License

MIT. See [LICENSE](LICENSE).
