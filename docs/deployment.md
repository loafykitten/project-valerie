# Homelab deployment

Ember uses `https://valerie.loafykitten.cafe`. The canonical checkout is `/home/ember/Developer/ProjectValerie`; production state is `/home/ember/.local/state/project-valerie` and remains outside source control. See [remote development](remote-development.md) for reload behavior.

## Current architecture

The existing Caddy container shares the `tailscale-sidecar` network namespace. DNS for `valerie.loafykitten.cafe` resolves to its Tailscale address. The [Caddy site block](../deploy/Caddyfile.valerie) restricts TCP peers to the observed personal devices and known tagged MacBook/homelab nodes, ignores forged forwarding headers, and returns 403 to other peers. There are no public host HTTP/HTTPS ports. Review the allowlist when devices change.

[Compose](../deploy/compose.dashboard.yaml) runs a pinned Bun image against the mounted remote checkout:

- Vite frontend: `127.0.0.1:3100`, the existing Caddy upstream. HTTPS and HMR WebSocket traffic share the private hostname.
- Bun API: `127.0.0.1:3101`, reached through Vite's API/health proxy. The proxy changes the upstream Host while preserving the browser Origin for API validation.
- Both join the sidecar namespace. Host loopback is a different network; a host-side service at the same numeric port is not the upstream.
- Code is mounted read-only to the services. The agent edits it on the host. Only the API receives the writable production-state mount; Vite gets temporary cache storage.
- Nonroot UID/GID, dropped capabilities, no-new-privileges, bounded logs and health checks are configured. Only the API receives `/home/ember/.config/project-valerie/integrations.env` (override with `VALERIE_INTEGRATIONS_FILE`). It contains Neuralwatt/Telegram credentials, the owner ID and the explicit `VALERIE_TELEGRAM_ENABLED` switch. Never print Compose's expanded environment or give this file to Vite.

The old `project-valerie.service` file is an unused historical host-side option, not this deployment's service manager. Do not install it alongside the Compose runtime.

## Host layout

```text
/home/ember/Developer/ProjectValerie/          Git source and Linux dependencies
/home/ember/.config/project-valerie/compose.env
/home/ember/.local/state/project-valerie/
  valerie.sqlite                             Authoritative application data
  character-imports/                         Private original card/export evidence
  backups/                                   Consistent SQLite backups
/home/ember/.cache/project-valerie-migration/ Initial transfer evidence
```

Bun 1.3.13 is installed for Ember at `/home/ember/.bun/bin/bun`; the login-shell PATH includes it. The container uses the same version. The desktop app's remote connection/authentication is configured separately by Ember. Machine-local credentials are not copied with source.

## First migration

1. Stop the old Mac preview so there is no competing interface for edits. Create a consistent SQLite `VACUUM INTO` backup, verify its integrity, and record hashes of current prompts, revision history, and original character records. Preserve the latest edited prompts rather than reimporting the card over them.
2. Transfer Git branch history and source without local dependencies, `.env`, Codex state or private application data. Clone under Ember's account at the canonical remote path. Install the locked Linux dependencies there.
3. Transfer private state separately. Seed the production database only if it does not exist, using exclusive creation. Verify the file hash, all prompt versions/content hashes, revision-history digest and character-record hashes before activation. Retain migration evidence and a backup. Later code updates must never reseed or overwrite this database.
4. Create private Compose settings with `VALERIE_UID=1000`, `VALERIE_GID=1000`, the absolute source/state paths, and the pinned runtime image. Validate Compose before starting.
5. Run required tests, including the isolated backend hot-reload check on the target Linux runtime. Start the API and frontend with Compose, then verify the deployed HTTPS page, private request boundaries, migrated data and hot-reload behavior.

## Routine startup and maintenance

```sh
docker compose --env-file /home/ember/.config/project-valerie/compose.env \
  -f /home/ember/Developer/ProjectValerie/deploy/compose.dashboard.yaml up -d
```

Normal source edits are observed directly; there is no per-edit image build. Schema/lifecycle and dependency changes require checks and a controlled restart as documented in [remote development](remote-development.md). Recreate containers for changed environment, mounts or runtime image. If the Tailscale sidecar is recreated, reconcile the network namespace of its dependent containers, including Caddy.

Caddy configuration is `/opt/stacks/caddy-sidecar/Caddyfile`. Preserve its backup and individually mounted file inode, validate with the installed Caddy build, then use a graceful `caddy reload`. Do not reformat or modify unrelated site blocks as a side effect.

## Retired LegacyNudges

Ember explicitly marked LegacyNudges obsolete and requested stopping/disabling it. Both `ember-reminder.service` and `ember-reminder-logs.service` remain retired; historical state is retained. Valerie reuses its bot with owner-authorized credentials. Never run both pollers. The new runtime implements Telegram text conversation; reminders remain unavailable. Do not restart LegacyNudges as an automatic rollback.

## Recovery

Keep production data in place when reverting code. The backend preserves the last activated handler after syntax/construction failures, but a logically incorrect edit may still need a code revert. If schema changes were applied, assess newer writes before restoring a database backup. Do not blindly replace production data with a Mac or earlier snapshot. Verify recovery through the private hostname and retain factual outcome logs.
