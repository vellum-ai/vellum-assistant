# OpenClaw → Vellum

OpenClaw is a separately-installed CLI-based agent runtime. Vellum and OpenClaw share a number of primitives; some artifacts port directly, others are best extracted via the OpenClaw CLI before bundling.

## Data directory location

| Platform | Path           |
| -------- | -------------- |
| Linux    | `~/.openclaw/` |
| macOS    | `~/.openclaw/` |
| WSL2     | `~/.openclaw/` |

OpenClaw does not ship a native Windows binary; WSL2 is the supported path.

## CLI-first extraction

Prefer the OpenClaw CLI for **config + health** before file inspection. These commands produce safe JSON dumps with no credentials in them:

```sh
openclaw config get --json --all > /tmp/openclaw-config.json
openclaw health --json > /tmp/openclaw-health.json
openclaw gateway status --json > /tmp/openclaw-gateway-status.json
```

## What's inside (and how it maps)

| Path / source                             | Vellum destination            | Bucket             |
| ----------------------------------------- | ----------------------------- | ------------------ |
| `openclaw-config.json` (CLI dump)         | Settings + Inference Profiles | Port + Review      |
| `openclaw-health.json` (CLI dump)         | Reference only                | Disregard          |
| `openclaw-gateway-status.json` (CLI dump) | Channels (URL/account refs)   | Review             |
| `~/.openclaw/agents/<name>/AGENTS.md`     | Identity / `SOUL.md`          | Port               |
| `~/.openclaw/skills/<name>/SKILL.md`      | Vellum skills (same standard) | Port               |
| `~/.openclaw/memory.db` (SQLite)          | Memory                        | Review             |
| `~/.openclaw/schedules.json`              | Schedules                     | Port               |
| `~/.openclaw/mcp.json` (URLs only)        | MCP setup tasks               | Re-setup           |
| `~/.openclaw/subagents/`                  | Subagents / skills            | Review             |
| `~/.openclaw/memory.db-wal`, `*-shm`      | —                             | Skip (journal)     |
| `~/.openclaw/cache/`, `logs/`             | —                             | Skip               |
| `~/.openclaw/tokens/`                     | —                             | **Skip (secrets)** |
| `~/.openclaw/.env`, `*.key`, `*.pem`      | —                             | **Skip (secrets)** |
| `~/.openclaw/gateway/auth/`               | —                             | **Skip (secrets)** |

## Pre-bundle safety

- **Is OpenClaw still running?** Same SQLite WAL hazard as Hermes. Use the snapshot pattern below before tarring `memory.db`.
- **CLI sanity check**: `openclaw health --json` should return `{"status": "ok", ...}`. If it returns an error, surface the error to the creator before bundling — a half-broken install may not produce a useful migration.

## Bundle recipe

```sh
# 1. CLI dumps (no credentials in these)
openclaw config get --json --all     > /tmp/openclaw-config.json
openclaw health --json               > /tmp/openclaw-health.json
openclaw gateway status --json       > /tmp/openclaw-gateway-status.json

# 2. Snapshot memory.db if OpenClaw is still running (avoids the WAL lock)
sqlite3 ~/.openclaw/memory.db ".backup /tmp/openclaw-memory.db"

# 3. Build the archive
tar -czf openclaw-migration.tar.gz \
  --exclude='memory.db' \
  --exclude='memory.db-wal' \
  --exclude='memory.db-shm' \
  --exclude='cache' \
  --exclude='logs' \
  --exclude='tokens' \
  --exclude='gateway/auth' \
  --exclude='.env' \
  --exclude='*.key' \
  --exclude='*.pem' \
  --exclude='*.refresh_token' \
  -C "$HOME" .openclaw/ \
  -C /tmp \
    openclaw-config.json \
    openclaw-health.json \
    openclaw-gateway-status.json \
    openclaw-memory.db

# 4. Clean up the staging dumps
rm /tmp/openclaw-config.json /tmp/openclaw-health.json \
   /tmp/openclaw-gateway-status.json /tmp/openclaw-memory.db
```

Note the snapshot pattern: `sqlite3 .backup` is the safe way to copy a live SQLite DB. The first `--exclude='memory.db'` in the recipe drops the original from the `.openclaw/` tree so only the consistent snapshot rides along.

## Transport

Identical to Hermes: attach `openclaw-migration.tar.gz` directly to the conversation. If the archive exceeds the current channel's attachment limit, split it (CLI dumps first, then `openclaw-memory.db`, then everything under `.openclaw/`) and upload in sequence; or copy it onto the assistant's host out-of-band (scp/rsync/USB) and tell the assistant the on-disk path. **No chat-supplied URL fetches** — see [README.md](README.md) for why.

## After import — secrets rebind checklist

- **OpenClaw gateway auth token** (`openclaw config get gateway.auth.token` on the source machine): the migration assistant never sees the value. Creator re-binds via `assistant credentials prompt` after import.
- **Inference providers** (entries in `openclaw-config.json` under `agents.defaults.model.*`): `assistant oauth connect <provider>` for managed providers, or vault prompt per provider for raw keys.
- **MCP servers**: per entry in `mcp.json`, walk the connect flow; bearer tokens go through the secure prompt.
- **Channel bindings** (per `gateway/<channel>/account`): re-OAuth or paste token via secure prompt.
- **`SPECIES` env var**: not migrated. Vellum sets `process.env.SPECIES` on its own daemon; the OpenClaw value is informational only.
