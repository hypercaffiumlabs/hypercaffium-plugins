# Hypercaffium plugins

[Claude Code](https://claude.com/claude-code) plugins that let Claude run your app-store work, safely: every change is previewed, confirmed and logged.

| Plugin | What it is |
|---|---|
| [`hypercaffium-apple`](hypercaffium-apple) | App Store Connect: releases, TestFlight, reviews, subscriptions. Its `/hypercaffium-apple:release-status` and `/hypercaffium-apple:check-changes` also cover Google Play when the Play plugin is installed. |
| [`hypercaffium-play`](hypercaffium-play) | Google Play Console: releases, listing, reviews, subscriptions |
| [`hypercaffium-google-oauth`](hypercaffium-google-oauth) | Google sign-in: Google Cloud project and APIs, Auth Platform branding, scopes, clients, publishing and account sign-ins |

## Install

The first command adds the Hypercaffium catalog; then install the plugin for each store you publish on.

```
/plugin marketplace add hypercaffiumlabs/hypercaffium-plugins
/plugin install hypercaffium-apple@hypercaffium
/plugin install hypercaffium-play@hypercaffium
```

Then run **`/hypercaffium-apple:setup`**, **`/hypercaffium-play:setup`** and/or **`/hypercaffium-google-oauth:setup`**. Each connects your account and lets you choose what the plugin may change, grouped by risk level. Critical areas (users, signing keys, refunds) start off and can only be switched on from a terminal menu.

## Safety model

Writes are off until you switch them on, and you choose which areas may be changed at all. A change is always two steps (prepare, then apply the exact ticket), is checked against the store's own schema, is classified into tiers by the server, and is written to an audit log with before and after values. Deletes, user management and signing assets are blocked.

## Repository layout

All three plugins live in this one repository. `shared/` holds code the store plugins have in common (the background watcher's notification engine); each plugin's build bundles its own copy into `server/dist/`, so every installed plugin stands alone.

```
cd shared && npm test                                  # shared watcher tests
cd hypercaffium-apple/server && npm install && npm test && npm run build
cd hypercaffium-play/server && npm install && npm test && npm run build
```

## License

MIT
