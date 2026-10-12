# Remote source and live updates

The canonical checkout is `/home/ember/Developer/ProjectValerie` on `homelab`. Select that folder in the desktop app's SSH connection. The user-facing dashboard is `https://valerie.loafykitten.cafe`. The Mac checkout is a migration/development copy, not the source of production data.

## Runtime

`deploy/compose.dashboard.yaml` uses the pinned `oven/bun:1.3.13` runtime with the remote checkout mounted read-only into two containers. The agent edits the host checkout; containers see those file changes without an image rebuild. Linux dependencies are installed once in the checkout with `bun install --frozen-lockfile`.

- `project-valerie-dashboard`: Vite on sidecar loopback port 3100, React/CSS hot updates, secure WebSocket through Caddy on port 443. API/health requests proxy to port 3101.
- `project-valerie-api`: Bun `--hot` on sidecar loopback port 3101, with the production SQLite directory mounted separately at `/var/lib/valerie`.
- Both share the existing `tailscale-sidecar` network namespace. There are no published host ports. The existing Caddy device allowlist remains the external access boundary.
- The frontend receives no database mount, provider keys, or automatic `.env` loading. Its filesystem allowlist is limited to dashboard code, dependency targets and its temporary cache. The checkout is not generally exposed as a file server.

Only the API receives the private integration environment file. `VALERIE_TELEGRAM_ENABLED=1` starts the owner-only text worker; credentials and the enable flag require a controlled container recreation. The dashboard receives no credentials. LegacyNudges remains stopped. Optional casual heartbeats share this worker and are enabled in the dashboard; reminders and general interval jobs remain unavailable.

## What reloads

| Change | Behavior |
| --- | --- |
| Prompts and stored settings | New values are read on the next operation/turn; no process restart. |
| React components and CSS | Vite hot refresh through the production hostname. Some edits require Vite's normal full browser reload. |
| HTTP routes, formatting, ordinary imported domain code | Bun re-evaluates modules and atomically replaces the request handler, retaining one store/listener. |
| Invalid syntax or failed handler construction | The last successfully activated backend handler remains available; fix the source and reload again. |
| Semantically incorrect code | Can still produce incorrect behavior. Hot reload does not replace tests or review. |
| Database schema, runtime lifecycle, listener contract | Bump `RUNTIME_CONTRACT` in `apps/server/src/index.ts`, then perform a controlled API restart. Schema migration runs only on initial store opening. |
| Database path, bind address or port | Soft activation is rejected; change deployment configuration and restart/recreate as appropriate. |
| Dependencies/lockfile, container environment, Vite config | Install/validate or change configuration, then restart the affected service. A base-image change requires recreation. |

`activateRuntime` owns one SQLite handle, one HTTP listener, one startup activity and one pair of shutdown handlers. New requests capture the newest successful handler; requests already accepted finish on the captured older handler. A failed constructor rolls back its database writes. This is genuine in-process HTTP hot reload, not a separate scripting language or arbitrary `eval` facility. [Bun hot mode](https://bun.com/docs/runtime/watch-mode#--hot-mode).

Controlled shutdown aborts the Telegram worker, allows up to five seconds for HTTP draining, closes remaining connections, joins background work, then closes SQLite and exits explicitly. An interrupted send is recorded unknown; interrupted generation can retry its pinned snapshot. Ordinary code reloads do not execute that shutdown path.

The Telegram worker is owned by `activateRuntime` through `startBackground`, not by the reloadable handler factory. HTTP edits retain that worker. It also owns the concurrent ComfyUI render loop, photo delivery and failure notices under the same lease and abort lifecycle. Changes to Telegram worker, ComfyUI or inference background code require a runtime-contract bump and controlled restart: they are not replaced by an HTTP reload. Future timers and long-lived resources must follow the same ownership rule.

## Daily work

Work directly in the remote checkout. Run `bun run check` and use fictional fixtures. `bun run test:hot` starts a temporary listener/database and verifies backend reload, old in-flight requests, invalid edits, persistence and resource ownership. For larger changes, use a worktree or temporary files for tests before applying the final edits to the live checkout. The live watcher can expose intermediate saves.

After changing a served feature, verify it at the production hostname. Do not finish by opening a Mac-only preview for Ember. Keep Git history and push reviewed changes to the private remote; keep application data out of Git.

Example managed restart using the host's private Compose settings:

```sh
docker compose --env-file /home/ember/.config/project-valerie/compose.env \
  -f /home/ember/Developer/ProjectValerie/deploy/compose.dashboard.yaml restart project-valerie-api
```

Use `up -d --force-recreate` instead when container environment/mounts change. If the Tailscale sidecar is recreated, recreate its dependent network-namespace containers, including Caddy, in the appropriate order; do not assume old namespace references reattach automatically.

## Production data

`/home/ember/.local/state/project-valerie` is authoritative and independent of source. Initial migration copies a consistent SQLite backup plus private source archives once, then compares hashes, all prompt revisions and import records. Later code updates never copy the Mac database over it. Backups and schema changes must preserve newer production writes. LegacyNudges was explicitly retired; rollback must not restart it without a new request.
