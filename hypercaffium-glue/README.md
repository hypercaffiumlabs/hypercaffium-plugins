# glue

The glue between [`hypercaffium-apple`](../hypercaffium-apple) and [`hypercaffium-play`](../hypercaffium-play): commands that report on *both* stores at once. Plugins cannot call each other, so this small plugin sits between them. It has no server and no credentials of its own.

**Publish on one store only? You do not need this.** Everything here is also available from the store plugin on its own: ask Claude for the release status or what changed, and it uses `asc_release_status` / `asc_check_changes` (App Store) or `play_release_status` / `play_check_changes` (Google Play).

## Commands

| Command | What it does |
|---|---|
| `/glue:release-status` | Where your app is on the App Store **and** Google Play right now: live, in review, rolling out, latest builds |
| `/glue:check-changes` | What changed on both stores since the last check: version and build states, review progress, new reviews |

Looking for background notifications? Each store plugin has its own optional watcher; see the "Background watcher" section in its README.

## Install

```
/plugin marketplace add hypercaffiumlabs/hypercaffium-plugins
/plugin install hypercaffium-apple@hypercaffium
/plugin install hypercaffium-play@hypercaffium
/plugin install glue@hypercaffium
```

## License

MIT. See [LICENSE](LICENSE).
