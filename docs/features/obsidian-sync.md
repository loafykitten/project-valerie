# Encrypted Obsidian vault synchronization

Owner: homelab operations. Valerie's memory feature consumes the synchronized Markdown files; it does not own the sync client or its credentials.

Status, 2026-09-14: encrypted bidirectional sync is running on homelab. Initial download, upload of three reviewed guidance documents, an independent download/hash comparison, and unattended reconnection after a controlled restart passed. The sync setup originally granted the API no vault access. The subsequent [memory implementation](memory-reflection.md) adds a separate read-only mount and enforced retrieval; sync itself performs no inference or reflection.

## Deployment

[Compose](../../deploy/compose.obsidian.yaml) runs the official `obsidian-headless` client, version 0.0.14, in a separate nonroot container. The Node 24 base image is pinned by digest; npm dependencies have their own lockfile. The service needs outbound access to Obsidian and publishes no ports. It is independent of the Telegram worker and the Caddy/Tailscale network namespace.

The default host locations are:

| Path | Purpose |
| --- | --- |
| `/home/ember/.local/share/obsidian/vault` | Decrypted Markdown vault and attachments |
| `/home/ember/.config/obsidian-headless` | Private account token, derived encryption key, sync configuration and local sync state |

Both locations are outside the source checkout. Their root directories have owner-only permissions. The sync container receives them as `/vault` and `/config/obsidian-headless`. `OBSIDIAN_VAULT_DIR`, `OBSIDIAN_CONFIG_DIR`, `OBSIDIAN_UID`, and `OBSIDIAN_GID` can override the deployment defaults.

The vault encryption password is used only for initial pairing. Preserve the resulting private client state across container replacement so routine restarts can reconnect unattended. Never put the encryption password in a command-line argument, image, Compose environment, prompt, activity record, or synced note. Interactive setup accepts it through a hidden prompt. `OBSIDIAN_ENC_KEY` can also supply a one-time in-process setup, provided the secret is passed through stdin rather than process arguments or container configuration.

## Initial setup

Build the runtime:

```sh
docker compose -f /home/ember/Developer/ProjectValerie/deploy/compose.obsidian.yaml build obsidian-sync
```

Sign in interactively on homelab. This is separate from entering the vault encryption password:

```sh
docker compose -f /home/ember/Developer/ProjectValerie/deploy/compose.obsidian.yaml run --rm --no-deps obsidian-sync login
```

List remote vaults, select the intended existing vault, and pair it with the empty local directory. Do not create another remote vault or merge an unrelated local collection as an incidental setup step.

```sh
docker compose -f /home/ember/Developer/ProjectValerie/deploy/compose.obsidian.yaml run --rm --no-deps obsidian-sync sync-list-remote --json
docker compose -f /home/ember/Developer/ProjectValerie/deploy/compose.obsidian.yaml run --rm --no-deps obsidian-sync sync-setup --vault '<remote-vault-id>' --path /vault --device-name homelab
```

Before the first transfer, configure:

- `pull-only` for the initial download and inspection; switch to `bidirectional` when reviewed edits are ready to synchronize.
- `conflict` resolution, preserving conflicting versions for review instead of automatically merging authored instructions.
- Configuration/plugin synchronization disabled. The headless client needs notes and attachments, not executable community plugins or device UI settings.
- All supported attachment categories retained, subject to the subscription's limits.
- `Private` excluded from homelab sync, following the proposed vault access boundary. Confirm actual folder names during inspection.

An initial one-time sync must finish successfully before treating the local copy as ready. Preserve a private copy before editing the vault documents. Review the documents describing Valerie's role, memory ownership, allowed writing, evidence, and forgetting before connecting any runtime retrieval.

## Operation

After pairing and initial verification, start the continuous service:

```sh
docker compose -f /home/ember/Developer/ProjectValerie/deploy/compose.obsidian.yaml up -d --no-build obsidian-sync
```

The restart policy resumes a previously running service after Docker restarts. An explicit stop remains stopped, including after a daemon restart; resume it deliberately when maintenance is finished. The client retains a vault lock; never run a second sync process against this directory. Configuration inspection does not start another sync process and does not require stopping the service:

```sh
docker compose -f /home/ember/Developer/ProjectValerie/deploy/compose.obsidian.yaml run --rm --no-deps obsidian-sync sync-status --path /vault --json
```

For a manual one-time transfer, stop continuous sync first and explicitly resume it after reviewing the result. Pairing or maintenance that intentionally leaves the vault paused should remain stopped until resolved.

```sh
docker compose -f /home/ember/Developer/ProjectValerie/deploy/compose.obsidian.yaml stop obsidian-sync
docker compose -f /home/ember/Developer/ProjectValerie/deploy/compose.obsidian.yaml run --rm --no-deps obsidian-sync sync --path /vault
docker compose -f /home/ember/Developer/ProjectValerie/deploy/compose.obsidian.yaml up -d --no-build obsidian-sync
```

`sync-status` reports configuration, not proof that every other device has uploaded its newest edits. Record actual transfer completion separately. Keep raw sync logs private because filenames may contain personal information. Docker retains at most three 5 MiB log files. For this pinned client, the duplicate private `sync/<vault-id>/sync.log` is a symlink to `/dev/null`; its normal console output is retained by Docker. Preserve that symlink when recreating the client configuration, and reassess this arrangement when upgrading the client. The sync-state database remains persistent and is not redirected.

## Valerie's access boundary

The sync service can read and write the synchronized collection as needed to replicate it. That does not grant the model permission to edit all those files. The memory interface separately enforces read-only retrieval; future writes must enforce the designated Valerie writing area, conflict handling and evidence alongside the existing read boundaries and turn snapshots.

Long-term vault prose is intended to be authoritative in Markdown. Core/short-term memory, original conversation evidence, audits, retrieval indexes, and reminder state remain owned by their application features. Sync performs no inference and does not implement RAG, memory extraction, reflection, or reminder scheduling.

Vault guidance documents shape memory behavior; they do not enable themselves as runtime policy.

## Acceptance

- Account sign-in and encrypted pairing succeed without exposing credentials.
- Initial download completes; excluded folders and disabled configuration syncing are confirmed.
- The local vault is backed up before its Valerie-specific documents are edited.
- Reviewed document changes synchronize successfully, with evidence beyond an HTTP/container health check.
- Continuous sync resumes after a controlled container restart without another password prompt.
- Synced credentials remain outside the vault and the Valerie runtime.
- Private logs have bounded retention. No second sync process is running against the same vault.

Sources: [official headless client](https://github.com/obsidianmd/obsidian-headless), [headless sync](https://obsidian.md/help/sync/headless), [encryption and local plaintext files](https://obsidian.md/help/sync/security).
