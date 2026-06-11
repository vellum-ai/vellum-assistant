# CLI Package — Agent Instructions

## Purpose

The `cli/` package (`@vellumai/cli`) manages the **lifecycle of Vellum assistant instances** — creating, starting, stopping, connecting to, and deleting them. Commands here operate on or across instances and typically require specifying which assistant to target.

This contrasts with `assistant/src/cli/`, where commands are scoped to a **single running assistant** and operate on its local state (config, memory, contacts, etc.).

## Scope

Commands here operate on or across **assistant instances** — creating, starting, stopping, connecting to, and deleting them. They require specifying which assistant to target and work without an assistant process running.

For commands scoped to a **single running assistant's** local state (config, memory, contacts), see `assistant/src/cli/AGENTS.md`.

Examples: `hatch`, `wake`, `sleep`, `retire`, `ps`, `ssh` belong here. `config`, `contacts`, `memory` belong in `assistant/src/cli/`.

## Assistant targeting convention

New or modified commands that act on a specific assistant should accept an assistant display name or ID as an argument. Exact assistant ID matches must win over display-name matches. Unique display-name matches may resolve to the matching assistant ID, but ambiguous display names must fail with an error that lists the matching IDs.

Use the shared helpers from `lib/assistant-config` instead of hand-rolled lookup:

- `lookupAssistantByIdentifier()` for commands that require an explicit target and need custom error handling.
- `resolveTargetAssistant()` for commands that may fall back to the active assistant or sole lockfile entry.
- `formatAssistantReference()` for user-facing output that should include both display name and ID when they differ.

Use `parseAssistantTargetArg()` from `lib/assistant-target-args` when parsing command arguments that may contain an unquoted multi-word display name. Do not store raw display names in `activeAssistant`; persist the resolved `assistantId`.

New or modified destructive lifecycle commands must be explicit and safe. A command that deletes, retires, archives, or removes assistant state must print the resolved assistant identity before acting and require an interactive confirmation, with a documented `--yes` bypass only for automation or higher-level clients that already own confirmation. Do not expose destructive lifecycle actions as `vellum client` slash commands.

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

## Boundary: No integration-specific references

The CLI is a generic lifecycle manager. It must **never** contain references to specific skills, integrations, or features (e.g. "Meet", "Slack", "Telegram"). Environment variables, volume mounts, and device passthroughs defined here must use generic names (e.g. `VELLUM_AVATAR_DEVICE`, not `VELLUM_MEET_AVATAR_DEVICE`). The skill that uses a resource decides how to interpret it — the CLI just passes it through.

Cross-package imports into `skills/` are forbidden. The CLI is distributed as an npm package; anything outside `cli/` is not included in the tarball and will fail to resolve at runtime.

## Boundary: No `.vellum/` directory access

The CLI must **never** read from or write to the `.vellum/` directory (e.g. `~/.vellum/protected/`, `<instanceDir>/.vellum/`). That directory structure is an **assistant daemon / gateway implementation detail**. The CLI's job is to spawn those processes and pass configuration via environment variables — not to reach into their internal storage.

For example, the signing key used for JWT auth between the daemon and gateway is persisted in the lockfile (`resources.signingKey`) so that client actor tokens survive daemon/gateway restarts. On first start (or when the key is missing), the CLI generates a new key via `generateLocalSigningKey()` in `lib/local.ts`, saves it to the lockfile entry, and passes it to both `startLocalDaemon` and `startGateway` as the `ACTOR_TOKEN_SIGNING_KEY` env var. The CLI does **not** read or write to the `.vellum/` directory for signing keys — it uses the lockfile instead.

**Exception: `~/.vellum/device.json`.** That file is the machine-wide shared device-identity file, co-owned by the Swift clients, the Electron main process, the host-mode assistant, and the CLI (see `clients/shared/App/Auth/DeviceIdStore.swift` and `apps/macos/src/main/device-id.ts`). The boundary rule covers daemon/gateway-internal state (e.g. `~/.vellum/protected/`, instance dirs), not this file.

## Process liveness

Use `resolveProcessState()` from `lib/process.ts` when checking whether a daemon or gateway should be (re)started. It combines PID existence with an HTTP `/healthz` probe, a readiness grace period, and a [`isVellumProcess()`](https://man7.org/linux/man-pages/man1/ps.1.html) guard against PID reuse — see the function's JSDoc for the full flow.

Reserve `isProcessAlive()` for teardown paths (`sleep`, `retire`) where you need to kill a process regardless of its health.

## Docker Volume Management

The CLI creates and manages six per-instance Docker volumes with strict per-service access boundaries (least-privilege at the container level).

| Volume                                      | Mount path           | Access                              | Contents                                                                         |
| ------------------------------------------- | -------------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| **Workspace** (`<name>-workspace`)          | `/workspace`         | Assistant: rw, Gateway: rw, CES: ro | `config.json`, conversations, apps, skills, db, logs, `.backups/`, `.backup.key` |
| **Gateway security** (`<name>-gateway-sec`) | `/gateway-security`  | Gateway only                        | `trust.json`, `actor-token-signing-key`, capability-token secrets                |
| **CES security** (`<name>-ces-sec`)         | `/ces-security`      | CES only                            | `keys.enc`, `store.key`                                                          |
| **Socket** (`<name>-socket`)                | `/run/ces-bootstrap` | Assistant + CES                     | CES bootstrap socket for initial handshake                                       |
| **Gateway IPC** (`<name>-gateway-ipc`)      | `/run/gateway-ipc`   | Assistant + Gateway                 | `gateway.sock` (assistant → gateway)                                             |
| **Assistant IPC** (`<name>-assistant-ipc`)  | `/run/assistant-ipc` | Assistant + Gateway                 | `assistant.sock` (gateway → assistant)                                           |

The assistant container's root (`/`) holds per-container ephemeral and persistent state: package installs (`~/.bun`), `device.json`, embed-worker PID files.

**Lifecycle**:

- `hatch` creates the six volumes.
- `retire` removes all of them.

**Mount rules**: each container receives only the volumes it needs. The assistant never mounts `gateway-security` or `ces-security`. The gateway never mounts `ces-security`. The CES mounts the workspace volume as read-only.

**Container security posture**: the assistant container runs as a non-root user (UID 1001) with no elevated capabilities — `--privileged`, `--cap-add`, and `--security-opt` overrides are not used; the host Docker socket is not bind-mounted; default Docker seccomp and AppArmor profiles remain active. Do not add elevated capabilities without a concrete runtime requirement.

**Backup paths in Docker mode**: backups land on the workspace volume (`VELLUM_BACKUP_DIR` defaults to `/workspace/.backups/`, key at `VELLUM_BACKUP_KEY_PATH` defaults to `/workspace/.backup.key`), so workspace-volume destruction loses both data and backups.
