# CLI Package — Agent Instructions

## Purpose

The `cli/` package (`@vellumai/cli`) manages the **lifecycle of Vellum assistant instances** — creating, starting, stopping, connecting to, and deleting them. Commands here operate on or across instances and typically require specifying which assistant to target.

This contrasts with `assistant/src/cli/`, where commands are scoped to a **single running assistant** and operate on its local state (config, memory, contacts, etc.).

## Scope

Commands here operate on or across **assistant instances** — creating, starting, stopping, connecting to, and deleting them. They require specifying which assistant to target and work without an assistant process running.

For commands scoped to a **single running assistant's** local state (config, memory, contacts), see `assistant/src/cli/AGENTS.md`.

Examples: `hatch`, `wake`, `sleep`, `retire`, `ps`, `ssh` belong here. `config`, `contacts`, `memory` belong in `assistant/src/cli/`.

## Assistant targeting convention

Commands that act on a specific assistant should accept an assistant name or ID as an argument. When none is specified, default to the most recently created local assistant. Use `loadAllAssistants()` and `findAssistantByName()` from `lib/assistant-config` for resolution.

## Conventions

- Commands are standalone exported functions in `src/commands/`.
- Each command manually parses `process.argv.slice(3)` (no framework — keep it lightweight).
- Register new commands in the `commands` object in `src/index.ts` and add a help line.
- User-facing output uses `console.log`/`console.error` directly (no shared logger).

## Help Text Standards

Every command must have high-quality `--help` output. Follow the same standards as `assistant/src/cli/AGENTS.md` § Help Text Standards, adapted for this package's manual argv parsing (no Commander.js).

### Requirements

1. **Each command**: Include a concise one-liner description in the help output,
   followed by an explanation of arguments/options with their formats and
   constraints.

2. **Include examples**: Show 2-3 concrete invocations with realistic values.

3. **Write for machines**: Be precise about formats, constraints, and side effects.
   AI agents parse help text to decide which command to run and how. Avoid vague
   language — say exactly what the command does and where state is stored.

## Boundary: No `.vellum/` directory access

The CLI must **never** read from or write to the `.vellum/` directory (e.g. `~/.vellum/protected/`, `<instanceDir>/.vellum/`). That directory structure is an **assistant daemon / gateway implementation detail**. The CLI's job is to spawn those processes and pass configuration via environment variables — not to reach into their internal storage.

For example, the signing key used for JWT auth between the daemon and gateway is persisted in the lockfile (`resources.signingKey`) so that client actor tokens survive daemon/gateway restarts. On first start (or when the key is missing), the CLI generates a new key via `generateLocalSigningKey()` in `lib/local.ts`, saves it to the lockfile entry, and passes it to both `startLocalDaemon` and `startGateway` as the `ACTOR_TOKEN_SIGNING_KEY` env var. The CLI does **not** read or write to the `.vellum/` directory for signing keys — it uses the lockfile instead.

## Docker Volume Management

The CLI creates and manages Docker volumes for containerized instances. See the root `AGENTS.md` § Docker Volume Architecture for the full volume layout.

**Volume creation** (`hatch`): Creates four volumes per instance — workspace, gateway-security, ces-security, and socket. The legacy data volume is no longer created.

**Volume migration** (`wake`/`hatch`): On startup, existing instances that still have a legacy data volume are migrated. `migrateGatewaySecurityFiles()` and `migrateCesSecurityFiles()` in `lib/docker.ts` copy security files from the data volume to their respective security volumes. Migrations are idempotent and non-fatal.

**Volume cleanup** (`retire`): All volumes (including the legacy data volume if it exists) are removed when an instance is retired.

**Volume mount rules**: Each service container receives only the volumes it needs. The assistant never mounts `gateway-security` or `ces-security`. The gateway never mounts `ces-security`. The CES mounts the workspace volume as read-only.
