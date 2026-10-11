# Hypercaffium plugins

[Claude Code](https://claude.com/claude-code) plugins that let Claude run your app-store work, safely: every change is previewed, confirmed and logged.

| Plugin | What it is |
|---|---|
| [`hypercaffium-apple`](hypercaffium-apple) | App Store Connect: releases, TestFlight, reviews, subscriptions |
| [`hypercaffium-play`](hypercaffium-play) | Google Play Console: releases, listing, reviews, subscriptions |
| [`glue`](hypercaffium-glue) | Combined status and change reports for both stores (skip it if you publish on one store only) |

## Install

The first command adds the Hypercaffium catalog; then install only the plugins you need.

```
/plugin marketplace add hypercaffiumlabs/marketplace
/plugin install hypercaffium-apple@hypercaffium
/plugin install hypercaffium-play@hypercaffium
/plugin install glue@hypercaffium
```

## Safety model, in one paragraph

Writes are off until you switch them on. A change is always two steps (prepare, then apply the exact ticket), is checked against the store's own schema, is classified into tiers by the server, and is written to an audit log with before and after values. Deletes, user management and signing assets are blocked.

## Repository layout

All three plugins live in this one repository. `shared/` holds code the store plugins have in common (the background watcher's notification engine); each plugin's build bundles its own copy into `server/dist/`, so every installed plugin stands alone.

```
cd shared && npm test                                  # shared watcher tests
cd hypercaffium-apple/server && npm install && npm test && npm run build
cd hypercaffium-play/server && npm install && npm test && npm run build
```

## License

MIT
