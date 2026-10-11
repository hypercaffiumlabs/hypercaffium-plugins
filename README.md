# Hypercaffium marketplace

One place to install all three [Claude Code](https://claude.com/claude-code) plugins for running your app-store work safely (every change is previewed, confirmed and logged):

| Plugin | What it does |
|---|---|
| [`hypercaffium-apple`](https://github.com/hypercaffiumlabs/hypercaffium-apple) | App Store Connect: releases, TestFlight, reviews, subscriptions |
| [`hypercaffium-play`](https://github.com/hypercaffiumlabs/hypercaffium-play) | Google Play Console: releases, listing, reviews, subscriptions |
| [`glue`](https://github.com/hypercaffiumlabs/hypercaffium-glue) | Cross-store status and change monitoring |

```
/plugin marketplace add hypercaffiumlabs/marketplace
/plugin install hypercaffium-apple@hypercaffium
/plugin install hypercaffium-play@hypercaffium
/plugin install glue@hypercaffium
```

Each plugin's README explains its one-time setup (API keys). Nothing is sent anywhere except to Apple's and Google's own APIs.

MIT licensed.
