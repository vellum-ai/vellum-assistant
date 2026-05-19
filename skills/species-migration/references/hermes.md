# Hermes → Vellum

Hermes is NousResearch's open-source self-hosted agent. It uses the same `agentskills.io` skill standard as Vellum, so most of its internals map cleanly.

## Data directory locations

| Platform          | Path                             |
| ----------------- | -------------------------------- |
| Linux             | `~/.hermes/`                     |
| macOS             | `~/.hermes/`                     |
| WSL2 (Linux side) | `~/.hermes/`                     |
| Termux            | `~/.hermes/`                     |
| Windows native    | `%LOCALAPPDATA%\hermes\`         |
| Docker (default)  | bind-mount of `/var/lib/hermes/` |

Confirm with the creator before bundling — they may have set `HERMES_HOME` to override the default.

## What's inside (and how it maps)

| Path inside the data directory   | Vellum destination            | Bucket             |
| -------------------------------- | ----------------------------- | ------------------ |
| `AGENTS.md`                      | Identity / `SOUL.md`          | Port               |
| `skills/<name>/SKILL.md`         | Vellum skills (same standard) | Port               |
| `skills/<name>/scripts/*`        | Skill scripts                 | Port               |
| `memory.db` (SQLite + FTS5)      | Memory                        | Review             |
| `schedules.json`                 | Schedules                     | Port               |
| `mcp.json` (URLs only)           | MCP setup tasks               | Re-setup           |
| `subagents/<name>/AGENTS.md`     | Subagents / additional skills | Review             |
| `gateway/accounts.json`          | Channels + Contacts           | Port + Review      |
| `providers.json` (non-secret)    | Inference Profiles            | Review             |
| Honcho user-model rows           | Memory                        | Review             |
| `memory.db-wal`, `memory.db-shm` | —                             | Skip (journal)     |
| `memory.db.fts5*`                | —                             | Skip (rebuildable) |
| `cache/`, `logs/`                | —                             | Skip               |
| `tokens/`, `oauth/refresh/`      | —                             | **Skip (secrets)** |
| `cookies.json`                   | —                             | **Skip (secrets)** |
| `.env`, `*.key`, `*.pem`         | —                             | **Skip (secrets)** |
| RL trajectories                  | —                             | Skip               |

## Pre-bundle safety

- **Is Hermes still running?** A held WAL on `memory.db` means yes. Either ask Hermes to stop, or copy `memory.db` to a snapshot first:
  ```sh
  sqlite3 ~/.hermes/memory.db ".backup ~/.hermes/memory.db.snapshot"
  ```
  Then bundle the snapshot. Never tar a SQLite file with a live WAL — the snapshot will be corrupt on read.
- **Confirm size**: `du -sh ~/.hermes` before bundling. If the directory is over ~1 GB, drop `memory.db` from the first pass and bring Memory across in a second migration once the metadata-only bundle has been reviewed.

## Bundle recipe

### bash (Linux / macOS / WSL2 / Termux)

```sh
tar -czf hermes-migration.tar.gz \
  --exclude='memory.db-wal' \
  --exclude='memory.db-shm' \
  --exclude='memory.db.fts5*' \
  --exclude='cache' \
  --exclude='logs' \
  --exclude='tokens' \
  --exclude='oauth/refresh' \
  --exclude='cookies.json' \
  --exclude='.env' \
  --exclude='*.key' \
  --exclude='*.pem' \
  --exclude='*.refresh_token' \
  -C "$HOME" .hermes/
```

### PowerShell (Windows native)

```powershell
$src = "$env:LOCALAPPDATA\hermes"
$staging = New-Item -ItemType Directory -Path "$env:TEMP\hermes-stage" -Force
Copy-Item -Path $src -Destination $staging -Recurse

$exclude = @(
  "memory.db-wal","memory.db-shm","memory.db.fts5*",
  "cache","logs","tokens","oauth",
  "cookies.json",".env","*.key","*.pem","*.refresh_token"
)
foreach ($pattern in $exclude) {
  Get-ChildItem $staging -Recurse -Force -Filter $pattern -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force
}

Compress-Archive -Path "$staging\*" -DestinationPath hermes-migration.zip
Remove-Item $staging -Recurse -Force
```

(Windows users can substitute `.zip` for `.tar.gz` throughout — the assistant handles both.)

## Transport

The skill accepts either path equally:

1. **Upload to the conversation** — attach `hermes-migration.tar.gz` directly to the chat. The assistant lands it in its workspace and extracts to a scratch directory.
2. **Hosted URL** — place the archive at a short-TTL signed URL (S3 pre-signed, GCS signed, Tailscale-internal HTTP, or any host the assistant can reach). Share the URL in chat. The assistant fetches with:
   ```sh
   curl -fL -o hermes-migration.tar.gz "<url>"
   ```
   once, then deletes the local copy after extraction.

Prefer **hosted URL** for archives over ~25 MB — chat attachment limits vary by interface.

## After import — secrets rebind checklist

The archive carries no secrets. Each of these must be re-established through Vellum before the migrated assistant can act:

- **Inference providers** (one per row in `providers.json`):
  `assistant oauth connect <provider>` for managed providers, or `credential_store action=prompt` for raw API keys
- **MCP servers** (one per entry in `mcp.json`): walk the connect flow for each; bearer tokens go through `credential_store action=prompt`
- **Gateway channels** (one per binding in `gateway/accounts.json`): re-OAuth or paste bot token via secure prompt — **never via chat text**
- **Cron / schedule notifications**: any schedule that delivers via a channel needs the channel rebound first

When in doubt, pause and ask before sending any production-grade message on a newly migrated channel.
