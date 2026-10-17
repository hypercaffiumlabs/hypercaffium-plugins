# Hypercaffium plugins

[Claude Code](https://claude.com/claude-code) plugins that let Claude run your app-store and Google sign-in work, safely: every change is previewed, confirmed and logged.

| Plugin | What it is |
|---|---|
| [`hypercaffium-apple`](hypercaffium-apple) | App Store Connect: releases, TestFlight, reviews, subscriptions. Its `/hypercaffium-apple:release-status` and `/hypercaffium-apple:check-changes` also cover Google Play when the Play plugin is installed. |
| [`hypercaffium-play`](hypercaffium-play) | Google Play Console: releases, listing, reviews, subscriptions |
| [`hypercaffium-google-oauth`](hypercaffium-google-oauth) | Google sign-in: creates new Google Cloud projects, turns on APIs, and sets up Auth Platform branding, scopes, clients, publishing and account sign-ins, plus a health check |

## Install

The first command adds the Hypercaffium catalog; then install the plugin for each store you publish on, and the Google sign-in plugin if you need it.

```
/plugin marketplace add hypercaffiumlabs/hypercaffium-plugins
/plugin install hypercaffium-apple@hypercaffium
/plugin install hypercaffium-play@hypercaffium
/plugin install hypercaffium-google-oauth@hypercaffium
```

Then run **`/hypercaffium-apple:setup`**, **`/hypercaffium-play:setup`** and/or **`/hypercaffium-google-oauth:setup`**. Each connects your account and lets you choose what the plugin may change, grouped by risk level. Critical areas (users, signing keys, refunds, removing Google sign-in setup) start off and can only be switched on from a terminal menu.

## Safety model

Writes are off until you switch them on, and you choose which areas may be changed at all. A change is always two steps (prepare, then apply the exact ticket), is checked against the store's own schema, is classified into tiers by the server, and is written to an audit log with before and after values. Other deletes and API keys are blocked. Critical changes (users, signing, refunds, and removing scopes or clients) go through a separate approval tool, only after you switch that area on in the terminal menu.

## Repository layout

All three plugins live in this one repository. `shared/` holds code the two store plugins have in common (the background watcher's notification engine). Each plugin's build bundles what it needs into its own `server/dist/`, so every installed plugin stands alone.

```
cd shared && npm test                                  # shared watcher tests
cd hypercaffium-apple/server && npm install && npm test && npm run build
cd hypercaffium-play/server && npm install && npm test && npm run build
cd hypercaffium-google-oauth/server && npm install && npm test && npm run build
```

## License

MIT
