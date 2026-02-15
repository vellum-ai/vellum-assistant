# Vellum Assistant

AI-powered assistant platform by Vellum.

## Architecture

The platform has two main components:

- **Assistant runtime** (`assistant/`): Bun + TypeScript daemon that owns conversation history, attachment storage, and channel delivery state in a local SQLite database. Exposes an HTTP API consumed by the gateway.
- **Gateway** (`gateway/`): Standalone Bun + TypeScript service that owns Telegram integration end-to-end. Receives Telegram webhooks, routes to the correct assistant via static settings, forwards to the assistant runtime, and sends replies back to Telegram. Optionally acts as an authenticated reverse proxy for the assistant runtime API (client → gateway → runtime).

## Repository Structure

```
/
├── assistant/         # Bun-based assistant runtime
├── clients/           # Desktop clients
├── gateway/           # Telegram gateway service
├── scripts/           # Utility scripts
└── .github/           # GitHub Actions workflows
```

## Prerequisites

- **Docker** is required. The sandbox uses Docker as its default backend for container-level isolation. Install [Docker Desktop](https://docs.docker.com/get-docker/) (macOS/Windows) or Docker Engine (Linux) and ensure the daemon is running before starting the assistant.

## Local Development

```bash
# Start local services (Postgres + MinIO)
docker compose up -d
```

## Git Hooks

This repository includes git hooks to help maintain code quality and security. The hooks are installed by running the install script directly.

To manually install or update hooks:
```bash
./.githooks/install.sh
```

See [.githooks/README.md](./.githooks/README.md) for more details about available hooks.

## Assistant Runtime

The assistant runtime lives in `/assistant`. See [assistant/README.md](./assistant/README.md) for details.

```bash
cd assistant
bun install
bun run src/index.ts daemon start
```

## Sandbox and Host Access Model

- Default tool workspace: `~/.vellum/data/sandbox/fs` (persistent global sandbox filesystem).
- Sandbox-scoped tools: `file_read`, `file_write`, `file_edit`, and `bash`.
- Explicit host tools: `host_file_read`, `host_file_write`, `host_file_edit`, and `host_bash` (absolute host paths only for host file tools).
- Host/computer-use prompts: `host_*`, `request_computer_control`, and `cu_*` default to `ask` unless allowlisted/denylisted in trust rules.
- Runtime override removal: CLI `--no-sandbox` is removed; legacy `sandbox_set` IPC messages are accepted but ignored (deprecated no-op).

### Sandbox Backend Selection

The `sandbox.backend` config option controls how the `bash` tool executes commands inside the sandbox. Two backends are available:

| Backend | Value | Description |
|---------|-------|-------------|
| **Docker** | `"docker"` (default) | Runs each command in an ephemeral `docker run --rm` container with the sandbox filesystem bind-mounted to `/workspace`. Requires Docker Desktop or Docker Engine. |
| **Native** | `"native"` | Uses OS-level sandboxing: `sandbox-exec` with SBPL profiles on macOS, `bwrap` (bubblewrap) on Linux. No extra dependencies on macOS. |

The **Docker** backend is the default because it provides stronger container-level isolation with a hardened security posture (all capabilities dropped, read-only root filesystem, network disabled by default). Docker Desktop or Docker Engine must be installed and running. The native backend is available as a **fallback** for environments where Docker is not available.

To switch to the native backend:

```bash
vellum config set sandbox.backend '"native"'
```

To switch back to Docker:

```bash
vellum config set sandbox.backend '"docker"'
```

### Docker Backend

When `sandbox.backend` is set to `"docker"`, the daemon wraps every sandbox `bash` invocation in an ephemeral Docker container. The container is created with `docker run --rm` and destroyed after each command.

**Prerequisites:**

- Docker installed and the `docker` CLI available in `PATH`.
- Docker daemon running (Docker Desktop on macOS/Windows, or `systemd` service on Linux).
- The configured image pulled locally. The default image is pinned with a `sha256` digest for reproducibility:
  ```
  node:20-slim@sha256:c6585df72c34172bebd8d36abed961e231d7d3b5cee2e01294c4495e8a03f687
  ```
  Pull it with: `docker pull node:20-slim@sha256:c6585df72c34172bebd8d36abed961e231d7d3b5cee2e01294c4495e8a03f687`

**Docker configuration options** (all under `sandbox.docker`):

| Option | Default | Description |
|--------|---------|-------------|
| `image` | `node:20-slim@sha256:...` | Container image (pinned with sha256 digest) |
| `shell` | `"bash"` | Shell used to wrap commands inside the container |
| `cpus` | `1` | CPU limit per container |
| `memoryMb` | `512` | Memory limit in MB |
| `pidsLimit` | `256` | Maximum number of processes |
| `network` | `"none"` | Network mode (`"none"` or `"bridge"`) |

**Container security posture:**

- All capabilities dropped (`--cap-drop=ALL`)
- No new privileges (`--security-opt=no-new-privileges`)
- Read-only container root filesystem (`--read-only`)
- Writable tmpfs for `/tmp` only
- Network disabled by default (`--network=none`)
- Host UID:GID forwarded to prevent permission drift

**Fail-closed behavior:**

If Docker is unavailable, commands fail immediately with actionable error messages rather than falling back to unsandboxed execution. The preflight checks run in dependency order:

1. Docker CLI installed
2. Docker daemon reachable
3. Configured image available locally
4. Bind-mount probe succeeds

Positive preflight results are cached for the lifetime of the daemon process. Negative results are never cached, so installing or starting Docker mid-session takes effect without a daemon restart.

### Host Tools

Host tools (`host_bash`, `host_file_read`, `host_file_write`, `host_file_edit`) are unchanged regardless of which sandbox backend is active. They always execute directly on the host and are subject to trust rules and permission prompts.

### Troubleshooting (Sandbox)

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Docker CLI is not installed or not in PATH` | Docker is not installed | Install Docker: https://docs.docker.com/get-docker/ |
| `Docker daemon is not running` | Docker Desktop is not started or systemd service is stopped | Start Docker Desktop, or run `sudo systemctl start docker` on Linux |
| `Docker image "..." is not available locally` | The configured image has not been pulled | Run `docker pull <image>` with the full image reference including the sha256 digest |
| `Cannot bind-mount the sandbox root into a Docker container` | Docker Desktop file sharing does not include the sandbox data directory | Open Docker Desktop > Settings > Resources > File Sharing and add the `~/.vellum/data/sandbox/fs` path (or your custom `dataDir` path) |
| `bwrap is not available or cannot create namespaces` (native backend, Linux) | bubblewrap is not installed or user namespaces are disabled | Install bubblewrap: `apt install bubblewrap` (Debian/Ubuntu) or `dnf install bubblewrap` (Fedora) |

Run `vellum doctor` for a full diagnostic check including sandbox backend status.

## Assistant Attachments

The assistant can attach files and images to its replies. Attachments flow through three delivery channels:

### Desktop (IPC)

Attachments are sent inline (base64) in `message_complete`, `generation_handoff`, and `history_response` IPC messages. The macOS app renders thumbnails for images and displays file metadata for documents.

### Runtime HTTP API

The `GET /v1/assistants/:id/messages` endpoint returns attachment metadata on each message:

```json
{
  "id": "att_xxx",
  "filename": "chart.png",
  "mimeType": "image/png",
  "sizeBytes": 12345,
  "kind": "image"
}
```

Fetch the full attachment payload (including base64-encoded data) via:

```
GET /v1/assistants/:assistantId/attachments/:attachmentId
```

### Telegram

The gateway downloads attachments from the runtime API and delivers them via Telegram's `sendPhoto` (images) or `sendDocument` (other files). Oversized attachments (exceeding `GATEWAY_MAX_ATTACHMENT_BYTES`, default 20 MB) are skipped. Partial failures send a user-visible notice listing undelivered files.

### Attachment Sources

The assistant creates attachments from two sources:

1. **Directives**: `<vellum-attachment source="sandbox|host" path="..." />` tags in response text. Sandbox paths are relative to the working directory; host paths require user approval.
2. **Tool output**: Image and file content blocks from tool results are automatically converted into attachments.

Limits: up to 5 attachments per turn, 20 MB each.

## Remote Access

Access a remote assistant daemon from your local machine via SSH.

### CLI (socket forwarding)

The CLI connects via Unix socket. Forward the socket with SSH:

```bash
ssh -L ~/.vellum/remote.sock:/home/user/.vellum/vellum.sock user@remote-host -N &
VELLUM_DAEMON_SOCKET=~/.vellum/remote.sock vellum
```

When `VELLUM_DAEMON_SOCKET` is set, autostart is disabled by default. Set `VELLUM_DAEMON_AUTOSTART=1` to override.

### macOS app (socket forwarding)

The macOS app also supports `VELLUM_DAEMON_SOCKET`. Launch it from the terminal:

```bash
ssh -L ~/.vellum/remote.sock:/home/user/.vellum/vellum.sock user@remote-host -N &
VELLUM_DAEMON_SOCKET=~/.vellum/remote.sock open -a Vellum
```

### Troubleshooting

| Symptom | Check |
|---|---|
| CLI: "could not connect to daemon socket" | Is the SSH socket tunnel active? Check `VELLUM_DAEMON_SOCKET` path |
| CLI: daemon starts locally despite socket override | Check that `VELLUM_DAEMON_AUTOSTART` is not set to `1` |
| macOS: not connecting | Verify socket path in `VELLUM_DAEMON_SOCKET` exists and is writable |
| Any: "connection refused" | Is the remote daemon running? (`vellum daemon status` on remote) |

Run `vellum doctor` for a full diagnostic check including socket path and autostart policy.

## Claude Code Workflow

This repo includes Claude Code slash commands (in `.claude/commands/`) for agent-driven development.

### Single-task commands

| Command | Purpose |
|---------|---------|
| `/do <description>` | Implement a change in an isolated worktree, create a PR, squash-merge it to main, and clean up. |
| `/safe-do <description>` | Like `/do` but creates a PR without auto-merging — pauses for human review. Keeps the worktree for feedback. |
| `/mainline` | Ship uncommitted changes already in your working tree to main via a squash-merged PR. |
| `/work` | Pick up the next task from `.private/TODO.md` (or a task you specify), implement it, PR it, and merge it. |

### Multi-task / parallel commands

| Command | Purpose |
|---------|---------|
| `/brainstorm` | Deep-read the codebase, generate a prioritized list of improvements, and update `.private/TODO.md` after approval. |
| `/swarm [workers] [max-tasks]` | Parallel execution — spawns a pool of agents (default 12) that work through `.private/TODO.md` concurrently, each in its own worktree. PRs are auto-assigned to the current user. |
| `/blitz <feature>` | End-to-end feature delivery — plans the feature, creates GitHub issues on a project board, swarm-executes them in parallel, sweeps for review feedback, addresses it, and reports. Merges directly to main. |
| `/safe-blitz <feature>` | End-to-end feature delivery on a feature branch — plans, creates issues, swarm-executes in parallel, sweeps for review feedback. All milestone PRs merge into a feature branch (not main). Creates a final PR for manual review. Does not switch your working tree. Supports `--auto`, `--workers N`, `--skip-plan`, `--branch NAME`. |
| `/safe-blitz-done [PR\|branch]` | Finalize a safe-blitz — squash-merges the feature branch PR into main, sets the project issue to Done, closes the issue, and deletes the local branch. Auto-detects the PR from current branch, open `feature/*` PRs, or project board "In Review" items. |
| `/execute-plan <file>` | Sequential multi-PR rollout — reads a plan file from `.private/plans/`, executes each PR in order, mainlining each before moving to the next. |

### Human-in-the-loop plan execution

A three-command workflow for executing plans one PR at a time with human review between each step. Each plan gets its own state file in `.private/safe-plan-state/`, so multiple plans can run concurrently in separate sessions.

| Command | Purpose |
|---------|---------|
| `/safe-execute-plan <file>` | Start a plan from `.private/plans/` — implements the first PR, creates it (without merging), and stops to wait for review. |
| `/safe-check-review [file]` | Check the active plan PR for feedback from codex/devin/humans. Addresses requested changes by pushing fixes. Waits if reviews are still pending — only recommends merging once all reviewers have responded. Auto-detects the plan if only one is active. |
| `/resume-plan [file]` | Merge the current PR, implement the next one, create it, and stop again. Repeats until the plan is complete. Auto-detects the plan if only one is active. |

**Typical flow:**

1. **`/safe-execute-plan MY_PLAN.md`** — starts the plan, creates PR 1, stops
2. **`/safe-check-review MY_PLAN.md`** — run periodically; waits for pending reviews, addresses feedback, or gives the all-clear to merge
3. **`/resume-plan MY_PLAN.md`** — merge PR 1, create PR 2, stop (only after `/safe-check-review` confirms all reviews are in)
4. Repeat steps 2–3 until the plan is complete

Multiple plans can run in parallel — just specify the plan name to disambiguate.

### Utility

| Command | Purpose |
|---------|---------|
| `/scrub` | Kill the running Vellum app (non-fatal if not running), wipe all persistent data, and relaunch the daemon and macOS app for a clean first-run experience. |

### Review

| Command | Purpose |
|---------|---------|
| `/check-reviews` | Checks for review feedback on unreviewed PRs, assesses feedback contextually (valid, nonsensical, or regression risk), creates follow-up tasks for valid feedback, and halts for user decision on regression risks. |

### Typical flow

1. **`/brainstorm`** — generate ideas, approve them into `TODO.md`
2. **`/swarm`** — burn through the TODO list in parallel
3. **`/check-reviews`** — sweep for reviewer feedback
4. **`/swarm`** again — address the feedback

Or for a focused feature: **`/blitz <feature>`** handles all of the above in one shot (plan, issues, swarm, sweep, report). Use **`/safe-blitz <feature>`** for the same workflow but with a feature branch and a final PR for manual review, then **`/safe-blitz-done`** to merge it when ready.

For controlled, sequential plan execution with human review at every step: **`/safe-execute-plan <file>`** → **`/safe-check-review`** → **`/resume-plan`** → repeat.

All workflows use squash-merge (no merge commits), worktree isolation for parallel work, and track state in `.private/TODO.md`, `.private/DONE.md`, and `.private/UNREVIEWED_PRS.md`.

## Release Management

Releases are cut using the `/release` Claude Code command and follow a fully automated pipeline from tag to client update.

### Cutting a release

Run `/release [version]` in Claude Code. If no version is provided, the patch version is auto-incremented from the latest git tag (e.g. `v0.1.5` becomes `v0.1.6`). The command:

1. Pulls the latest `main` branch
2. Generates release notes from commits since the last tag, grouped into Features, Fixes, and Infrastructure
3. Creates a GitHub Release with the corresponding git tag
4. Confirms the CI build was triggered

### What happens after a release is created

Creating the GitHub Release triggers three workflows in parallel:

- **Build and Release macOS App** (`build-and-release-macos.yml`): Builds the macOS `.app` from source, compiles the Bun daemon binary, code-signs it with a Developer ID certificate, notarizes it with Apple, creates a DMG installer, and publishes both the DMG and a Sparkle-compatible ZIP + `appcast.xml` to the public updates repo ([alex-nork/vellum-assistant-macos-updates](https://github.com/alex-nork/vellum-assistant-macos-updates)). This takes ~15-20 minutes.
- **Publish velly to npm** (`publish-velly.yml`): Publishes the `velly` CLI package to npm with provenance.
- **Slack Release Notification** (`slack-release-notification.yml`): Posts a summary message to the releases Slack channel with a threaded changelog.

### Auto-updates for macOS clients

The macOS app uses [Sparkle](https://sparkle-project.org/) for automatic updates. When a new release is published to the public updates repo, existing client installations detect the update via the `appcast.xml` feed, download the new version, and install it automatically — no manual action required from users. The update check happens periodically in the background while the app is running.

### First-time installation

New users download the latest DMG from the [public updates repo releases page](https://github.com/alex-nork/vellum-assistant-macos-updates/releases/latest), open it, and drag the app to their Applications folder. All subsequent updates are handled automatically by Sparkle.

## License

Proprietary - Vellum AI
