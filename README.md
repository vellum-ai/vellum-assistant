# Vellum Assistant

AI-powered assistant platform by Vellum.

## Architecture

The platform has three main components:

- **Assistant runtime** (`assistant/`): Bun + TypeScript daemon that owns conversation history, attachment storage, and channel delivery state in a local SQLite database. Exposes a Unix domain socket (macOS) and optional TCP listener (iOS) for native clients, plus an HTTP API consumed by the gateway.
- **Native clients** (`clients/`): Swift Package with macOS and iOS apps sharing ~45-50% of code via `VellumAssistantShared`. The macOS app is a menu bar assistant with computer-use (accessibility + CGEvent). The iOS app is a chat client supporting standalone mode (direct Anthropic API) and connected-to-Mac mode (TCP proxy through the daemon).
- **Gateway** (`gateway/`): Standalone Bun + TypeScript service that owns Telegram integration end-to-end. Receives Telegram webhooks, routes to the correct assistant via static settings, forwards to the assistant runtime, and sends replies back to Telegram. Optionally acts as an authenticated reverse proxy for the assistant runtime API (client → gateway → runtime).

## Repository Structure

```
/
├── assistant/         # Bun-based assistant runtime (daemon, CLI, HTTP API)
├── clients/           # Native clients (macOS menu bar app + iOS chat app)
├── gateway/           # Telegram gateway service
├── benchmarking/      # Load testing scripts (gateway webhook/proxy benchmarks)
├── scripts/           # Utility scripts (publishing, tunneling)
├── .claude/           # Claude Code slash commands and workflow tools
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

The assistant runtime lives in `/assistant`.

```bash
cd assistant
bun install
bun run src/index.ts daemon start
```

> **Note:** Some dependencies (`agentmail`, `@pydantic/logfire-node`) are optional at runtime but required for full `tsc --noEmit` type-checking to pass. They are installed automatically by `bun install`.

## Sandbox and Host Access Model

- Default tool workspace: `~/.vellum/workspace` (persistent global sandbox filesystem).
- Sandbox-scoped tools: `file_read`, `file_write`, `file_edit`, and `bash`.
- Explicit host tools: `host_file_read`, `host_file_write`, `host_file_edit`, and `host_bash` (absolute host paths only for host file tools).
- Host/computer-use prompts: `host_*` and `computer_use_*` (including `computer_use_request_control`) default to `ask` unless allowlisted/denylisted in trust rules.
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
- The sandbox image available locally. The default image (`vellum-sandbox:latest`) is built automatically from `assistant/Dockerfile.sandbox` on first use. It extends `node:20-slim` with `curl`, `ca-certificates`, and `bash`. To build it manually:
  ```
  docker build -t vellum-sandbox:latest -f assistant/Dockerfile.sandbox assistant/
  ```

**Docker configuration options** (all under `sandbox.docker`):

| Option | Default | Description |
|--------|---------|-------------|
| `image` | `vellum-sandbox:latest` | Container image (auto-built from Dockerfile.sandbox) |
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
| `Cannot bind-mount the sandbox root into a Docker container` | Docker Desktop file sharing does not include the sandbox data directory | Open Docker Desktop > Settings > Resources > File Sharing and add the `~/.vellum/workspace` path (or your custom `dataDir` path) |
| `bwrap is not available or cannot create namespaces` (native backend, Linux) | bubblewrap is not installed or user namespaces are disabled | Install bubblewrap: `apt install bubblewrap` (Debian/Ubuntu) or `dnf install bubblewrap` (Fedora) |

Run `vellum doctor` for a full diagnostic check including sandbox backend status.

## Credential Storage and Secret Security

The assistant can store and use credentials (API keys, tokens, passwords) without exposing secret values to the LLM or logs.

- **Storage**: Secret values are stored in the macOS Keychain via `secure-keys.ts`, with an encrypted file fallback for Linux/headless environments or degraded Keychain sessions. Metadata (service, field, label, usage policy) is stored in a JSON file at `~/.vellum/workspace/data/credentials/metadata.json`.
- **Secret prompt**: When a credential is needed, a floating `SecretPromptView` panel appears. The user enters the value in a `SecureField` — the LLM never sees it.
- **Ingress blocking**: Inbound user messages are scanned for secrets (regex + entropy). When `secretDetection.blockIngress` is `true` (the default), messages containing secrets are rejected with a notice to use the secure prompt instead. The `secretDetection.action` setting (default: `redact`) separately controls how secrets in tool *output* are handled.
- **Usage policy**: Each credential can specify `allowedTools` and `allowedDomains`. The `CredentialBroker` enforces these policies at use time.
- **One-time send**: When `secretDetection.allowOneTimeSend` is enabled (default: `false`), a "Send Once" button lets users provide a value for immediate use without persisting it.
- **No plaintext read API**: There is no tool-layer function that returns a stored secret as plaintext. Secrets are only consumed by the broker for scoped tool execution.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full security model and data flow diagrams.

#### Credential References

When using `credential_ids` in proxied shell commands, you can use either format:
- **UUID**: The canonical credential ID (shown in `credential_store list` output and `store`/`prompt` success messages)
- **service/field**: A human-readable reference like `fal/api_key`

Unknown references fail immediately with a clear error before the command executes.

#### Wildcard Host Matching

Wildcard patterns like `*.fal.run` match:
- Subdomains: `api.fal.run`, `queue.fal.run`
- The bare domain: `fal.run`

When one credential has both an exact pattern (`api.fal.run`) and a wildcard pattern (`*.fal.run`), the exact match takes precedence.

#### Multi-Credential Ambiguity Blocking

When multiple credentials are passed to a proxied command via `credential_ids`, the proxy resolves which credential to inject for each request using a two-level specificity algorithm:

1. **Per-credential selection**: For each credential, the proxy picks the most specific matching header template (exact host > wildcard). If a single credential has multiple templates that match with equal specificity, the request is **blocked** (returns 403).

2. **Cross-credential resolution**: After selecting the best template per credential, the proxy checks how many credentials produced a match. If exactly one credential matches, its header is injected. If **more than one credential** matches the same host, the request is **blocked** — the proxy cannot determine which credential to use and refuses to guess.

Requests that match zero session credentials are handled in two ways: if the target host matches a known credential template in the global registry (i.e., *some* credential exists for that host, just not one bound to this session), the request is **blocked** by default. If the host is completely unknown to the credential system, the request passes through without injection.

**Example**: If credential A has pattern `*.example.com` and credential B has pattern `api.example.com`, a request to `api.example.com` is blocked because both credentials match (even though B's match is more specific — specificity is only compared within a single credential, not across credentials).

#### Debugging Proxied 401 Errors

If a proxied command receives a 401 or 403 despite having the correct credential stored:

1. **Check the credential reference**: Run `credential_store list` and verify the credential ID or `service/field` matches what you're passing to `credential_ids`.
2. **Check host pattern matching**: The credential's `hostPattern` must match the target host. A wildcard pattern `*.example.com` matches `api.example.com` and the bare domain `example.com`. An exact pattern `api.example.com` only matches that specific host.
3. **Check for ambiguity**: If two credentials match the same host with equal specificity, injection is blocked. Use `credential_store list` to check for overlapping patterns.
4. **Check the header template**: Ensure the credential has an `injectionTemplate` with `injectionType: "header"` and the correct `headerName` (e.g., `Authorization`) and `valuePrefix` (e.g., `Bearer `).
5. **Enable debug logging**: Set `LOG_LEVEL=debug` to see decision traces from the policy engine and rewrite callback, including which patterns matched and which credential was selected.

## Integrations

Vellum integrates with third-party services via OAuth2. Each integration is exposed as a bundled skill with its own set of tools.

### Messaging (Gmail, Slack)

The unified messaging layer provides platform-agnostic tools (`messaging_send`, `messaging_read`, `messaging_search`, etc.) that delegate to provider adapters. Gmail and Slack each implement the `MessagingProvider` interface. Platform-specific tools (e.g. `gmail_archive`, `slack_add_reaction`) extend beyond the generic interface where needed.

Connect via the Settings UI or `integration_connect` IPC message. OAuth2 tokens are stored in the credential vault — the LLM never sees raw tokens.

### Twitter (X)

Twitter integration has two components: an OAuth2 identity flow and a CDP-based posting path.

- **OAuth2 PKCE flow** (`local_byo` mode): The user provides their own Twitter OAuth2 Client ID (and optional Client Secret). The daemon runs a standard OAuth2 PKCE flow against `twitter.com/i/oauth2/authorize` and `api.x.com/2/oauth2/token`. This flow is used for **identity verification only** (`GET /2/users/me`) — it confirms the user's Twitter account and stores credentials in the vault, but is not used for posting. Connect via the Settings UI or `twitter_auth_start` IPC message.

- **Browser session posting** (CDP): The `vellum x post` CLI command posts via Chrome DevTools Protocol, executing GraphQL mutations through an authenticated x.com browser tab. This is the **only posting mechanism**. Session cookies are captured via Ride Shotgun (`vellum x refresh`).

**Available tool**: `twitter_post` — posts a tweet via CDP. OAuth2 scopes (`tweet.read`, `tweet.write`, `users.read`, `offline.access`) are requested during the auth flow, but posting is handled exclusively through the browser session.

**Setup**: Store your Twitter app's Client ID via the credential vault (`credential:integration:twitter:oauth_client_id`). Optionally store a Client Secret. Initiate the OAuth2 flow from the Settings UI to verify your identity. For posting, ensure Chrome is running with remote debugging enabled and an authenticated x.com tab.

## Dynamic Skill Authoring

The assistant can create, test, and persist new skills at runtime. This is useful when no existing tool or skill covers a user's need.

### Workflow

1. **Evaluate**: The assistant drafts a TypeScript snippet and tests it in a sandbox via `evaluate_typescript_code`. Iterates until it passes.
2. **Persist**: After successful evaluation and explicit user consent, the assistant calls `scaffold_managed_skill` to write the skill to `~/.vellum/workspace/skills/<id>/`.
3. **Load**: The assistant calls `skill_load` with the new skill ID to load its instructions.
4. **Delete**: To remove a managed skill, use `delete_managed_skill`.

### Tools

| Tool | Risk Level | Description |
|------|-----------|-------------|
| `evaluate_typescript_code` | High | Run a TypeScript snippet in a sandbox. Returns structured JSON with `ok`, `exitCode`, `result`, `stdout`, `stderr`. |
| `scaffold_managed_skill` | High | Write a managed skill to `~/.vellum/workspace/skills/<id>/`. Creates `SKILL.md` with frontmatter (including optional `includes` for child skills) and updates `SKILLS.md` index. |
| `delete_managed_skill` | High | Remove a managed skill directory and its index entry. |

All three tools require explicit user approval before execution (Risk Level = High).

### Constraints

- Snippets must export a `default` or `run` function with signature `(input: unknown) => unknown | Promise<unknown>`.
- If evaluation fails after 3 attempts, the assistant asks for user guidance instead of retrying.
- After a skill is written or deleted, the file watcher triggers session eviction. The next turn runs in a fresh session.
- Managed skills appear in the macOS Settings UI with Inspect and Delete controls.

### Child Skill Includes

Skills can declare relationships to other skills via the `includes` frontmatter field. This is metadata-only — it does **not** auto-activate child tools or instructions.

```yaml
---
name: "Parent Workflow"
description: "Orchestrates sub-tasks"
includes: ["data-analysis", "report-generator"]
---
```

When a parent skill is loaded via `skill_load`:
- The include graph is validated recursively (missing children and cycles are rejected).
- Immediate child metadata (ID, name, description, path) is shown in the output.
- Child skills are **not** automatically activated — the agent must explicitly call `skill_load` for each child it needs.

The `scaffold_managed_skill` tool accepts an optional `includes` array to set this metadata when creating managed skills.

## Browser Capabilities

Web browsing is provided by the bundled `browser` skill. Browser tools are not available by default — the skill must be loaded first.

### Activating browser tools

There are two ways to activate browser capabilities:

1. **Slash command**: Use `/browser` to explicitly load the browser skill.
2. **Automatic loading**: When the agent determines that browser capabilities are needed, it calls `skill_load` to load the skill automatically.

Once loaded, the following tools become available for the remainder of the session:

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL |
| `browser_snapshot` | List interactive elements on the current page |
| `browser_screenshot` | Take a visual screenshot |
| `browser_close` | Close the browser page |
| `browser_click` | Click an element |
| `browser_type` | Type text into an input |
| `browser_press_key` | Press a keyboard key |
| `browser_wait_for` | Wait for a condition |
| `browser_extract` | Extract page text content |
| `browser_fill_credential` | Fill a stored credential into a form field |

### Permissions

All `browser_*` tools are declared as low-risk. The system seeds default trust rules for `skill_load` and every `browser_*` tool, so they are auto-allowed in both legacy and strict permission modes out of the box. The exception is `browser_navigate` (and `web_fetch`) with `allow_private_network=true` — these are elevated to high-risk and will prompt for approval unless a matching trust rule has `allowHighRisk: true`. Users can override the default rules via `~/.vellum/protected/trust.json` if they want to require explicit approval (default rules cannot be removed, only disabled).

## Permission Modes and Trust Rules

The assistant uses a permission system to control which tool actions the agent can execute without explicit user approval. Permission behavior is configured via `permissions.mode`:

```bash
# Default — ALL tools require an explicit trust rule, no implicit auto-allow
vellum config set permissions.mode '"strict"'

# Legacy — low-risk tools auto-allowed, medium/high prompted
vellum config set permissions.mode '"legacy"'
```

### Trust rules

User approval decisions are persisted as trust rules in `~/.vellum/protected/trust.json`. Rules support:

- **Pattern matching**: Minimatch glob patterns for tool commands and file paths.
- **Principal binding**: Rules can target specific skills (`principalId`) and even specific versions (`principalVersion`) via content hashing.
- **Execution target binding**: Rules can be scoped to `sandbox` or `host` execution contexts.
- **High-risk override**: Rules with `allowHighRisk: true` auto-allow even high-risk tool invocations.

### Version-bound skill approvals

When you approve a skill-originated action, the trust rule can record the skill's version hash. If the skill's source files change, the hash changes and the old rule no longer matches — you are re-prompted. This prevents modified skills from silently inheriting previous approvals.

### Starter approval bundle

In strict mode, a **starter bundle** can be accepted to seed common safe rules (file reads, glob, grep, web search, etc.), reducing initial prompt noise without compromising security for mutation or execution tools.

### Skill source mutation protection

When `file_write`, `file_edit`, `host_file_write`, or `host_file_edit` targets a path inside a skill directory (managed, bundled, workspace, or extra), the operation is escalated to **high risk**. This prevents the agent from modifying skill code — which could alter its own capabilities — without explicit user consent. Note that mutations via `bash` are not covered by this escalation.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full permission evaluation flow diagrams and [`assistant/docs/skills.md`](assistant/docs/skills.md) for detailed skills security documentation.

## Assistant Attachments

The assistant can attach files and images to its replies. Attachments flow through three delivery channels:

### Desktop (IPC)

Attachments are sent inline (base64) in `message_complete`, `generation_handoff`, and `history_response` IPC messages. The macOS app renders thumbnails for images and displays file metadata for documents.

### Runtime HTTP API

The `GET /v1/assistants/:id/messages?conversationKey=<key>` endpoint returns attachment metadata on each message (the `conversationKey` query parameter is required):

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

## Inline Media Embeds

The desktop app automatically renders inline previews for images and video URLs that appear in chat messages. Instead of showing a bare link, recognized URLs are replaced with an embedded preview directly in the conversation.

### Supported Content

- **Images**: URLs ending in common image extensions (`.png`, `.jpg`, `.gif`, `.webp`, etc.) are rendered as inline images with lazy loading.
- **Videos**: Embeds from YouTube, Vimeo, and Loom are rendered as click-to-play video players.

URLs inside code blocks and code spans are never converted to embeds.

### Settings

Media embeds are controlled by settings under `ui.mediaEmbeds` in `~/.vellum/workspace/config.json`. These settings are also accessible from the standalone Settings window and the main-window settings panel.

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Global toggle for all inline media embeds |
| `videoAllowlistDomains` | `["youtube.com", "youtu.be", "vimeo.com", "loom.com"]` | Domains allowed to render video embeds |
| `enabledSince` | *(timestamp)* | Only messages created after this timestamp show embeds, so toggling the feature on does not retroactively modify older conversations |

### Security and Privacy

- Video embeds use **ephemeral webview storage** — no cookies or site data persist between sessions.
- Videos require an explicit **click to play**; nothing auto-plays.
- Image loads are **lazy** — off-screen images are not fetched until they scroll into view.
- Video webviews are **torn down when scrolled offscreen** to free memory and stop background activity.

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

### Blob Transport Behavior

When the macOS client connects to a local daemon, large CU observation payloads (screenshots, AX trees) are offloaded to file-based blobs at `~/.vellum/workspace/data/ipc-blobs/` instead of being embedded inline in IPC JSON. On connect, the client probes whether client and daemon share the same blob directory. If the probe succeeds, large payloads are written as blob files and only lightweight references travel over the socket.

Over SSH-forwarded sockets, the probe fails automatically (the filesystems don't overlap), so the client falls back to inline base64/text payloads transparently. On iOS (TCP connections), the probe is skipped entirely and inline payloads are always used. No configuration is needed.

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
| `/ship-and-merge [title]` | Ship uncommitted changes via a PR with automated review feedback loop — waits for Codex/Devin reviews, fixes valid feedback (up to 3 rounds), and squash-merges. |
| `/work` | Pick up the next task from `.private/TODO.md` (or a task you specify), implement it, PR it, and merge it. |

### Multi-task / parallel commands

| Command | Purpose |
|---------|---------|
| `/brainstorm` | Deep-read the codebase, generate a prioritized list of improvements, and update `.private/TODO.md` after approval. |
| `/swarm [workers] [max-tasks] [--namespace NAME]` | Parallel execution — spawns a pool of agents (default: 12 workers) that work through `.private/TODO.md` concurrently, each in its own worktree. Uses `--namespace` to prefix branch names and avoid collisions with other parallel swarms (auto-generates a random 4-char hex if omitted). When `--namespace` is explicitly provided, only TODO items prefixed with `[<namespace>]` are processed; when auto-generated, all items are processed. PRs are auto-assigned to the current user. |
| `/blitz <feature>` | End-to-end feature delivery — plans the feature, creates GitHub issues on a project board, swarm-executes them in parallel, sweeps for review feedback (scoped to the namespace), addresses it, and reports. Merges directly to main. Derives a namespace from the feature description for branch naming, collision avoidance, and scoping review sweeps/TODO items to only this blitz's PRs. |
| `/safe-blitz <feature>` | End-to-end feature delivery on a feature branch — plans, creates issues, swarm-executes in parallel, sweeps for review feedback (scoped to the namespace). All milestone PRs merge into a feature branch (not main). Creates a final PR for manual review. Does not switch your working tree. Derives a namespace from the feature description for branch naming, collision avoidance, and scoping review sweeps/TODO items to only this blitz's PRs. Supports `--auto`, `--workers N`, `--skip-plan`, `--branch NAME`. |
| `/safe-blitz-done [PR\|branch]` | Finalize a safe-blitz — squash-merges the feature branch PR into main, sets the project issue to Done, closes the issue, and deletes the local branch. Auto-detects the PR from current branch, open `feature/*` PRs, or project board "In Review" items. |
| `/execute-plan <file>` | Sequential multi-PR rollout — reads a plan file from `.private/plans/`, executes each PR in order, mainlining each before moving to the next. |
| `/check-reviews-and-swarm [workers] [max-tasks] [--namespace NAME]` | Combined review sweep + execution pass — runs review checks, then swarms on actionable feedback items. When `--namespace` is provided, it is passed to both `/check-reviews` (to filter PRs and prefix TODO items) and `/swarm` (to filter TODO items and namespace branches). When omitted, `/check-reviews` still infers namespaces from PR branch names matching `swarm/<NAME>/...`. |

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
| `/plan-html <topic\|plan-name>` | Create or refresh a rollout plan in `.private/plans/` with both markdown and a polished, review-friendly HTML view (including per-PR file lists). |
| `/release [version]` | Cut a release: pull main, determine/create version tag, generate release notes, publish GitHub Release, and verify CI trigger. |
| `/update` | Pull latest from `main`, restart daemon/app, preserve any source-run gateway process, and launch app with `VELLUM_GATEWAY_DIR` pinned to local `gateway/`. |


### Review

| Command | Purpose |
|---------|---------|
| `/check-reviews [--namespace NAME]` | Checks for review feedback on unreviewed PRs, assesses feedback contextually (valid, nonsensical, or regression risk), creates follow-up tasks for valid feedback, and halts for user decision on regression risks. When `--namespace` is provided, only PRs whose head branch starts with `swarm/<namespace>/` are processed, and any TODO items added are prefixed with `[<namespace>]`. When `--namespace` is omitted, all PRs are processed, but TODO items are still namespaced if the PR's branch name matches `swarm/<NAME>/...` (the namespace is inferred from the branch). |

### Typical flow

1. **`/brainstorm`** — generate ideas, approve them into `TODO.md`
2. **`/swarm`** — burn through the TODO list in parallel
3. **`/check-reviews`** — sweep for reviewer feedback
4. **`/swarm`** again — address the feedback

Or for a focused feature: **`/blitz <feature>`** handles all of the above in one shot (plan, issues, swarm, sweep, report). Use **`/safe-blitz <feature>`** for the same workflow but with a feature branch and a final PR for manual review, then **`/safe-blitz-done`** to merge it when ready.

For controlled, sequential plan execution with human review at every step: **`/safe-execute-plan <file>`** → **`/safe-check-review`** → **`/resume-plan`** → repeat.

All workflows use squash-merge (no merge commits), worktree isolation for parallel work, and track state in `.private/TODO.md` and `.private/UNREVIEWED_PRS.md`.

**Validation**: Slash commands do **not** run tests, type-checking (`tsc`), or linting by default. These steps are only performed when the task specifically requires it (e.g., "fix the type errors", "make the tests pass"). This keeps agent-driven workflows fast for well-scoped changes.

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

- **Build and Release macOS App** (`build-and-release-macos.yml`): Builds the macOS `.app` from source, compiles the Bun daemon binary, code-signs it with a Developer ID certificate, notarizes it with Apple, creates a DMG installer, and publishes both the DMG and a Sparkle-compatible ZIP + `appcast.xml` to the public updates repo ([vellum-ai/velly](https://github.com/vellum-ai/velly)). This takes ~15-20 minutes.
- **Publish velly to npm** (`publish-velly.yml`): Publishes the `velly` CLI package to npm with provenance.
- **Slack Release Notification** (`slack-release-notification.yml`): Posts a summary message to the releases Slack channel with a threaded changelog.

### Auto-updates for macOS clients

The macOS app uses [Sparkle](https://sparkle-project.org/) for automatic updates. When a new release is published to the public updates repo, existing client installations detect the update via the `appcast.xml` feed, download the new version, and install it automatically — no manual action required from users. The update check happens periodically in the background while the app is running.

### First-time installation

New users download the latest DMG from the [public updates repo releases page](https://github.com/vellum-ai/velly/releases/latest), open it, and drag the app to their Applications folder. All subsequent updates are handled automatically by Sparkle.

## License

Proprietary - Vellum AI
