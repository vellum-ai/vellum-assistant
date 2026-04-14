# Internal Reference

Detailed reference documentation for the Vellum Assistant platform. For an overview and quick start, see the [README](../README.md).

## Table of Contents

- [**Getting Started**](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Git Hooks](#git-hooks)
  - [Assistant Runtime](#assistant-runtime)
- [**Security & Permissions**](#security--permissions)
  - [Sandbox and Host Access Model](#sandbox-and-host-access-model)
  - [Credential Storage and Secret Security](#credential-storage-and-secret-security)
  - [Permission Modes and Trust Rules](#permission-modes-and-trust-rules)
- [**Features & Capabilities**](#features--capabilities)
  - [Integrations](#integrations)
  - [Dynamic Skill Authoring](#dynamic-skill-authoring)
  - [Browser Capabilities](#browser-capabilities)
  - [Assistant Attachments](#assistant-attachments)
  - [Inline Media Embeds](#inline-media-embeds)
- [**API & Communication**](#api--communication)
  - [Assistant Events SSE Stream](#assistant-events-sse-stream)
  - [Remote Access](#remote-access)
- [**Development Workflow**](#development-workflow)
  - [Claude Code Workflow](#claude-code-workflow)
  - [Release Management](#release-management)
- [**Telephony STT Architecture**](#telephony-stt-architecture)
  - [Overview](#overview)
  - [Provider-Conditional Routing](#provider-conditional-routing)
  - [Troubleshooting Matrix](#troubleshooting-matrix)
  - [Twilio Media-Stream Troubleshooting](#twilio-media-stream-troubleshooting)
- [**Conversation STT Streaming Operator Runbook**](#conversation-stt-streaming-operator-runbook)
  - [Architecture Summary](#architecture-summary)
  - [Debugging Stream Sessions](#debugging-stream-sessions)
  - [Log Anchors](#log-anchors)
  - [Expected Event Sequences](#expected-event-sequences)
  - [Common Failure Scenarios](#common-failure-scenarios)
  - [Rollout Validation Checklist](#rollout-validation-checklist)

## Getting Started

### Prerequisites

- **Docker** is required. The sandbox uses Docker as its default backend for container-level isolation. Install [Docker Desktop](https://docs.docker.com/get-docker/) (macOS/Windows) or Docker Engine (Linux) and ensure Docker is running before starting the assistant.

### Git Hooks

This repository includes git hooks to help maintain code quality and security. The hooks are installed by running the install script directly.

To manually install or update hooks:
```bash
./.githooks/install.sh
```

See [.githooks/README.md](../.githooks/README.md) for more details about available hooks.

### Assistant Runtime

The assistant runtime lives in `/assistant`. The recommended way to start it is via the `vellum` CLI:

```bash
vellum wake    # starts assistant + gateway from current checkout
vellum ps      # check process status
vellum sleep   # stop assistant + gateway
```

> **Note:** `vellum wake` requires a hatched assistant. Run `vellum hatch` first, or launch the macOS app which handles hatching automatically. Alternatively, the macOS app supports **managed sign-in** during onboarding — authenticating via the platform and connecting to a platform-hosted assistant without running a local assistant.

#### Development: raw bun commands

For low-level development (e.g., working on the assistant runtime itself):

```bash
cd assistant
bun install
bun run src/index.ts assistant start
```

> **Note:** Some dependencies (`agentmail`) are optional at runtime but required for full `tsc --noEmit` type-checking to pass. They are installed automatically by `bun install`.

## Security & Permissions

### Sandbox and Host Access Model

- Default tool workspace: `~/.vellum/workspace` (persistent global sandbox filesystem).
- Sandbox-scoped tools: `file_read`, `file_write`, `file_edit`, and `bash`.
- Explicit host tools: `host_file_read`, `host_file_write`, `host_file_edit`, and `host_bash` (absolute host paths only for host file tools).
- Host/computer-use prompts: `host_*` and `computer_use_*` tools default to `ask` unless allowlisted/denylisted in trust rules.
- Runtime override removal: CLI `--no-sandbox` is removed; the sandbox mode is always active.

#### Sandbox Backend

The sandbox uses native OS-level sandboxing: `sandbox-exec` with SBPL profiles on macOS, `bwrap` (bubblewrap) on Linux. No extra dependencies on macOS.

**Fail-closed behavior:**

If the native sandbox backend is unavailable, commands fail immediately with actionable error messages rather than falling back to unsandboxed execution.

#### Host Tools

Host tools (`host_bash`, `host_file_read`, `host_file_write`, `host_file_edit`) are unchanged regardless of which sandbox backend is active. They always execute directly on the host and are subject to trust rules and permission prompts.

#### Troubleshooting (Sandbox)

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Docker CLI is not installed or not in PATH` | Docker is not installed | Install Docker: https://docs.docker.com/get-docker/ |
| `Docker daemon is not running` | Docker Desktop is not started or systemd service is stopped | Start Docker Desktop, or run `sudo systemctl start docker` on Linux |
| `Docker image "..." is not available locally` | The configured image has not been pulled | Run `docker pull <image>` with the full image reference including the sha256 digest |
| `Cannot bind-mount the sandbox root into a Docker container` | Docker Desktop file sharing does not include the sandbox data directory | Open Docker Desktop > Settings > Resources > File Sharing and add the `~/.vellum/workspace` path (or your custom `dataDir` path) |
| `bwrap is not available or cannot create namespaces` (native backend, Linux) | bubblewrap is not installed or user namespaces are disabled | Install bubblewrap: `apt install bubblewrap` (Debian/Ubuntu) or `dnf install bubblewrap` (Fedora) |

Run `vellum doctor` for a full diagnostic check including sandbox backend status.

### Credential Storage and Secret Security

The assistant can store and use credentials (API keys, tokens, passwords) without exposing secret values to the LLM or logs.

- **Storage**: Secret values are stored via the Credential Execution Service (CES) or the encrypted file store (`~/.vellum/protected/keys.enc`). The daemon resolves credential storage via CES RPC (primary), CES HTTP (containerized/Docker), or encrypted file store (fallback). Metadata (service, field, label, usage policy) is stored in a JSON file at `~/.vellum/workspace/data/credentials/metadata.json`.
- **Secret prompt**: When a credential is needed, a floating `SecretPromptView` panel appears. The user enters the value in a `SecureField` — the LLM never sees it.
- **Usage policy**: Each credential can specify `allowedTools` and `allowedDomains`. The `CredentialBroker` enforces these policies at use time.
- **One-time send**: When `secretDetection.allowOneTimeSend` is enabled (default: `false`), a "Send Once" button lets users provide a value for immediate use without persisting it.
- **No plaintext read API**: There is no tool-layer function that returns a stored secret as plaintext. Secrets are only consumed by the broker for scoped tool execution.

See [`assistant/docs/architecture/security.md`](../assistant/docs/architecture/security.md) for the full security model and [`ARCHITECTURE.md`](../ARCHITECTURE.md) for the cross-system map.

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

### Permission Modes and Trust Rules

The assistant uses a permission system to control which tool actions the agent can execute without explicit user approval. Permission behavior is configured via `permissions.mode`:

| Mode | Default? | Behavior |
|---|---|---|
| `workspace` | Yes | Workspace-scoped operations (file reads/writes/edits within workspace, sandboxed bash) are auto-allowed without prompting. Host operations, network requests, and operations outside the workspace still follow the normal approval flow. Explicit deny and ask rules override auto-allow. |
| `strict` | No | Every tool invocation without an explicit matching trust rule prompts the user. No implicit auto-allow for any risk level. |

To switch modes:

```bash
# Workspace mode (default) — workspace-scoped ops auto-allowed, others follow risk-based policy
assistant config set permissions.mode '"workspace"'

# Strict — ALL tools require an explicit trust rule, no implicit auto-allow
assistant config set permissions.mode '"strict"'
```

Existing users with `permissions.mode: "strict"` explicitly in their config will continue to use that mode unchanged.

#### Trust rules

User approval decisions are persisted as trust rules in `~/.vellum/protected/trust.json`. Rules support:

- **Pattern matching**: Minimatch glob patterns for tool commands and file paths.
- **Execution target binding**: Rules can be scoped to `sandbox` or `host` execution contexts.
- **High-risk override**: Rules with `allowHighRisk: true` auto-allow even high-risk tool invocations.

#### Shell command allowlist options

When you approve a shell command (`host_bash` or `bash`), the permission prompt offers parser-derived allowlist options based on the command's structure. The shell parser extracts "action keys" — hierarchical identifiers that represent the command family — instead of using whitespace-split patterns.

For example, `cd /repo && gh pr view 5525 --json title` generates these allowlist options:

- `cd /repo && gh pr view 5525 --json title` — the full original command text (exactly what will be approved)
- `gh pr view *` — any `gh pr view` command (trust rule pattern: `action:gh pr view`)
- `gh pr *` — any `gh pr` command (trust rule pattern: `action:gh pr`)
- `gh *` — any `gh` command (trust rule pattern: `action:gh`)

Setup prefixes (`cd`, `export`, `pushd`, etc.) are stripped before deriving action keys for the broader pattern options, but the exact option always uses the full original command text.

**Compound commands** (with `&&`, `||`, `|`) that contain multiple non-prefix actions only offer an exact-command option — no broad action-family patterns. This prevents a complex pipeline from being over-generalized into a permissive rule.

**Scope ordering**: When persisting a rule, scope options are always ordered from narrowest to broadest: project > parent directories > everywhere. The macOS app shows an explicit scope picker (two-step flow: select pattern, then select scope) so users always see where the rule will apply.

#### Version-bound skill approvals

When you approve a skill-originated action, the trust rule can record the skill's version hash. If the skill's source files change, the hash changes and the old rule no longer matches — you are re-prompted. This prevents modified skills from silently inheriting previous approvals.

#### Starter approval bundle

In strict mode, a **starter bundle** can be accepted to seed common safe rules (file reads, glob, grep, web search, etc.), reducing initial prompt noise without compromising security for mutation or execution tools.

#### Skill source mutation protection

When `file_write`, `file_edit`, `host_file_write`, or `host_file_edit` targets a path inside a skill directory (managed, bundled, workspace, or extra), the operation is escalated to **high risk**. This prevents the agent from modifying skill code — which could alter its own capabilities — without explicit user consent. Note that mutations via `bash` are not covered by this escalation.

See [`assistant/docs/architecture/security.md`](../assistant/docs/architecture/security.md) for permission evaluation flow diagrams and [`assistant/docs/skills.md`](../assistant/docs/skills.md) for detailed skills security documentation.

## Features & Capabilities

### Integrations

Vellum integrates with third-party services via OAuth2. Each integration is exposed as a bundled skill with its own set of tools.

#### Messaging (Gmail, Telegram)

The unified messaging layer provides platform-agnostic tools (`messaging_send`, `messaging_read`, `messaging_search`, etc.) that delegate to provider adapters. Gmail implements the `MessagingProvider` interface. Telegram is also supported as a messaging provider, though with limited capabilities compared to Gmail: bots can send messages to known chat IDs but cannot list conversations, retrieve message history, or search messages (Bot API limitations). Bots can only message users or groups that have previously interacted with the bot. Platform-specific tools (e.g. `gmail_archive`) extend beyond the generic interface where needed.

**Slack is not handled by the messaging skill.** Slack messaging (send, read, search) uses the Slack Web API directly via CLI. The `slack` skill provides instructions for using the Web API via `bash` with `network_mode: "proxied"` and `credential_ids: ["slack_channel/bot_token"]` — the credential proxy injects the bot token automatically. There are no dedicated Slack tools.

Connect Gmail via the Settings UI or the `integration_connect` HTTP endpoint. OAuth2 tokens are stored in the credential vault — the LLM never sees raw tokens. Slack connects via Socket Mode using a bot token and app-level token — see the `slack-app-setup` skill. Telegram uses a bot token (not OAuth) — see the `telegram-setup` skill for setup instructions.

### Dynamic Skill Authoring

The assistant can create, test, and persist new skills at runtime. This is useful when no existing tool or skill covers a user's need.

#### Workflow

1. **Evaluate**: The assistant drafts a TypeScript snippet and tests it in a sandbox via `evaluate_typescript_code`. Iterates until it passes.
2. **Persist**: After successful evaluation and explicit user consent, the assistant calls `scaffold_managed_skill` to write the skill to `~/.vellum/workspace/skills/<id>/`.
3. **Load**: The assistant calls `skill_load` with the new skill ID to load its instructions.
4. **Delete**: To remove a managed skill, use `delete_managed_skill`.

#### Tools

| Tool | Risk Level | Description |
|------|-----------|-------------|
| `evaluate_typescript_code` | High | Run a TypeScript snippet in a sandbox. Returns structured JSON with `ok`, `exitCode`, `result`, `stdout`, `stderr`. |
| `scaffold_managed_skill` | High | Write a managed skill to `~/.vellum/workspace/skills/<id>/`. Creates `SKILL.md` with frontmatter (including optional `includes` for child skills) and updates `SKILLS.md` index. |
| `delete_managed_skill` | High | Remove a managed skill directory and its index entry. |

All three tools require explicit user approval before execution (Risk Level = High).

#### Constraints

- Snippets must export a `default` or `run` function with signature `(input: unknown) => unknown | Promise<unknown>`.
- If evaluation fails after 3 attempts, the assistant asks for user guidance instead of retrying.
- After a skill is written or deleted, the file watcher triggers conversation eviction. The next turn runs in a fresh conversation.
- Managed skills appear in the macOS Settings UI with Inspect and Delete controls.

#### Child Skill Includes

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

### Browser Capabilities

Web browsing is provided by the bundled `browser` skill. Browser tools are not available by default — the skill must be loaded first.

#### Activating browser tools

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

#### Permissions

All `browser_*` tools are declared as low-risk. The system seeds default trust rules for `skill_load` and every `browser_*` tool, so they are auto-allowed in all permission modes out of the box. The exception is `browser_navigate` (and `web_fetch`) with `allow_private_network=true` — these are elevated to high-risk and will prompt for approval unless a matching trust rule has `allowHighRisk: true`. Users can override the default rules via `~/.vellum/protected/trust.json` if they want to require explicit approval (default rules cannot be removed, only disabled).

### Assistant Attachments

The assistant can attach files and images to its replies. Attachments flow through three delivery channels:

#### Desktop (HTTP+SSE)

Attachments are sent inline (base64) in `message_complete`, `generation_handoff`, and `history_response` SSE events. The macOS app renders thumbnails for images and displays file metadata for documents.

#### Runtime HTTP API

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

#### Telegram

The gateway downloads attachments from the runtime API and delivers them via Telegram's `sendPhoto` (images) or `sendDocument` (other files). Oversized attachments (exceeding 20 MB) are skipped. Partial failures send a user-visible notice listing undelivered files.

#### Attachment Sources

The assistant creates attachments from two sources:

1. **Directives**: `<vellum-attachment source="sandbox|host" path="..." />` tags in response text. Sandbox paths are relative to the working directory; host paths require user approval.
2. **Tool output**: Image and file content blocks from tool results are automatically converted into attachments.

Limits: 100 MB per attachment (20 MB for Telegram).

### Inline Media Embeds

The desktop app automatically renders inline previews for images and video URLs that appear in chat messages. Instead of showing a bare link, recognized URLs are replaced with an embedded preview directly in the conversation.

#### Supported Content

- **Images**: URLs ending in common image extensions (`.png`, `.jpg`, `.gif`, `.webp`, etc.) are rendered as inline images with lazy loading.
- **Videos**: Embeds from YouTube, Vimeo, and Loom are rendered as click-to-play video players.

URLs inside code blocks and code spans are never converted to embeds.

#### Settings

Media embeds are controlled by settings under `ui.mediaEmbeds` in `~/.vellum/workspace/config.json`. These settings are also accessible from the standalone Settings window and the main-window settings panel.

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Global toggle for all inline media embeds |
| `videoAllowlistDomains` | `["youtube.com", "youtu.be", "vimeo.com", "loom.com"]` | Domains allowed to render video embeds |
| `enabledSince` | *(timestamp)* | Only messages created after this timestamp show embeds, so toggling the feature on does not retroactively modify older conversations |

#### Security and Privacy

- Video embeds use **ephemeral webview storage** — no cookies or site data persist between sessions.
- Videos require an explicit **click to play**; nothing auto-plays.
- Image loads are **lazy** — off-screen images are not fetched until they scroll into view.
- Video webviews are **torn down when scrolled offscreen** to free memory and stop background activity.

## API & Communication

### Assistant Events SSE Stream

The runtime HTTP server exposes a Server-Sent Events (SSE) endpoint that streams real-time assistant events for a specific conversation.

#### Endpoint

```
GET /v1/events?conversationKey=<key>
```

**Auth**: JWT bearer token (same rules as other runtime HTTP endpoints). The SSE endpoint requires a valid JWT with the `chat.read` scope, passed as `Authorization: Bearer <jwt>`. JWTs are issued by the assistant's auth system (see Vellum Guardian Identity for the bootstrap flow). The route policy in `route-policy.ts` enforces scope requirements per endpoint.

**Query params**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `conversationKey` | No | Stable, client-chosen key that maps to a conversation. Same key used for `POST /v1/assistants/:id/runs`. When omitted, subscribes to events from all conversations. |

**Response**: `200 OK` with `Content-Type: text/event-stream`. Each frame is a standard SSE event:

```
event: assistant_event
id: <uuid>
data: {"id":"...","assistantId":"self","conversationId":"conv_xxx","emittedAt":"2026-02-21T12:00:00.000Z","message":{...}}

```

Keep-alive heartbeat comments are emitted every 30 seconds to prevent proxy timeouts:

```
: heartbeat

```

#### Event Payload

Each `data` field is a JSON-serialized `AssistantEvent`:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "assistantId": "self",
  "conversationId": "conv_abc123",
  "emittedAt": "2026-02-21T12:00:00.000Z",
  "message": {
    "type": "assistant_text_delta",
    "conversationId": "conv_abc123",
    "text": "Working on it..."
  }
}
```

The `message` field is the `ServerMessage` payload. All delta semantics are preserved:

| Message type | Description |
|---|---|
| `assistant_text_delta` | Incremental text token from the model |
| `assistant_thinking_delta` | Incremental thinking/reasoning token |
| `tool_use_start` | Tool invocation starting |
| `tool_input_delta` | Streaming tool input chunk |
| `tool_output_chunk` | Streaming tool output chunk |
| `tool_result` | Tool execution result |
| `message_complete` | Turn complete; full message + attachments included |
| `confirmation_request` | User approval needed before an action executes |
| `generation_handoff` | Model handed off to a sub-agent |
| `generation_cancelled` | Run was cancelled |

#### Connection Management

- **Capacity**: Up to 100 concurrent SSE connections are maintained. When the cap is reached the **oldest** connection is evicted (stream closed) to make room for the new one.
- **Slow consumers**: If a client's receive buffer fills (16 events queued, unread), the connection is closed.
- **Disconnect cleanup**: Closing the browser tab, cancelling the reader, or aborting the request all dispose the subscription deterministically.

#### Example (JavaScript)

The standard browser `EventSource` API does not support custom request headers, so authenticated connections require `fetch()` with manual SSE stream parsing:

```js
const TOKEN = '<jwt>'; // JWT obtained via the guardian bootstrap flow or assistant auth system
const res = await fetch(
  'http://localhost:3001/v1/events?conversationKey=my-conversation',
  { headers: { Authorization: `Bearer ${TOKEN}` } },
);

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });

  // SSE frames are separated by a blank line (\n\n).
  const frames = buf.split('\n\n');
  buf = frames.pop() ?? ''; // keep the incomplete trailing chunk

  for (const frame of frames) {
    const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
    if (!dataLine) continue;
    const event = JSON.parse(dataLine.slice(6));
    console.log(event.message.type, event.message);
  }
}
```

### Remote Access

Access a remote assistant from your local machine via SSH.

#### CLI (SSH port forwarding)

The CLI connects via HTTP. Forward the assistant's HTTP port with SSH:

```bash
ssh -L 8741:localhost:8741 user@remote-host -N &
VELLUM_DAEMON_URL=http://localhost:8741 vellum
```

When connecting to a remote assistant, autostart is disabled by default. Set `VELLUM_DAEMON_AUTOSTART=1` to override.

#### macOS app (SSH port forwarding)

The macOS app also supports remote connections. Launch it from the terminal:

```bash
ssh -L 8741:localhost:8741 user@remote-host -N &
VELLUM_DAEMON_URL=http://localhost:8741 open -a Vellum
```

#### Troubleshooting

| Symptom | Check |
|---|---|
| CLI: "could not connect to assistant" | Is the SSH port tunnel active? Check `VELLUM_DAEMON_URL` |
| CLI: assistant starts locally despite remote override | Check that `VELLUM_DAEMON_AUTOSTART` is not set to `1` |
| macOS: not connecting | Verify the assistant URL is reachable |
| Any: "connection refused" | Is the remote assistant running? (`vellum ps` on remote) |

Run `vellum doctor` for a full diagnostic check.

## Development Workflow

### Claude Code Workflow

This repo includes Claude Code slash commands (in `.claude/commands/`) for agent-driven development.

#### Single-task commands

| Command | Purpose |
|---------|---------|
| `/do <description>` | Implement a change in an isolated worktree, create a PR, squash-merge it to main, and clean up. |
| `/safe-do <description>` | Like `/do` but creates a PR without auto-merging — pauses for human review. Keeps the worktree for feedback. |
| `/mainline` | Ship uncommitted changes already in your working tree to main via a squash-merged PR. |
| `/ship-and-merge [title]` | Ship uncommitted changes via a PR with automated review feedback loop — waits for Codex/Devin reviews, fixes valid feedback (up to 3 rounds), and squash-merges. |
| `/work` | Pick up the next task from `.private/TODO.md` (or a task you specify), implement it, PR it, and merge it. |

#### Multi-task / parallel commands

| Command | Purpose |
|---------|---------|
| `/brainstorm` | Deep-read the codebase, generate a prioritized list of improvements, and update `.private/TODO.md` after approval. |
| `/swarm [workers] [max-tasks] [--namespace NAME]` | Parallel execution — spawns a pool of agents (default: 12 workers) that work through `.private/TODO.md` concurrently, each in its own worktree. Uses `--namespace` to prefix branch names and avoid collisions with other parallel swarms (auto-generates a random 4-char hex if omitted). When `--namespace` is explicitly provided, only TODO items prefixed with `[<namespace>]` are processed; when auto-generated, all items are processed. PRs are auto-assigned to the current user. |
| `/blitz <feature>` | End-to-end feature delivery — plans the feature, creates GitHub issues on a project board, swarm-executes them in parallel, then gates each PR on Codex/Devin review approval before merging (per-PR feedback loops with up to 3 fix cycles). Runs a **recursive sweep loop** (check reviews, swarm to address feedback, review and merge feedback PRs, repeat) until all PRs — including transitive feedback PRs — are fully reviewed with no remaining action items. Merges directly to main. Supports `--auto`, `--workers N`, `--skip-plan`, `--skip-reviews`. Pass `--skip-reviews` to merge PRs immediately without waiting for reviews (opt-in; default is to wait). Derives a namespace from the feature description for branch naming, collision avoidance, and scoping review sweeps/TODO items to only this blitz's PRs. |
| `/safe-blitz <feature>` | End-to-end feature delivery on a feature branch — plans, creates issues, executes milestones sequentially with per-milestone **direct-push feedback loops** (check reviews, push fixes directly to the milestone branch, re-request reviews, repeat until clean or 3 cycles), then automatically runs a final sweep on the entire feature branch (no user approval prompt). All milestone PRs merge into a feature branch (not main). Creates a final PR for manual review. Does not switch your working tree. Derives a namespace from the feature description for branch naming, collision avoidance, and scoping review sweeps/TODO items to only this blitz's PRs. Supports `--workers N`, `--skip-plan`, `--branch NAME`. |
| `/safe-blitz-done [PR\|branch]` | Finalize a safe-blitz — squash-merges the feature branch PR into main, sets the project issue to Done, closes the issue, and deletes the local branch. Auto-detects the PR from current branch, open `feature/*` PRs, or project board "In Review" items. |
| `/execute-plan <file>` | Sequential multi-PR rollout — reads a plan file from `.private/plans/`, executes each PR in order, mainlining each before moving to the next. |
| `/check-reviews-and-swarm [workers] [max-tasks] [--namespace NAME]` | Combined review sweep + execution pass — runs review checks, then swarms on actionable feedback items. When `--namespace` is provided, it is passed to both `/check-reviews` (to filter PRs and prefix TODO items) and `/swarm` (to filter TODO items and namespace branches). When omitted, `/check-reviews` still infers namespaces from PR branch names matching `swarm/<NAME>/...`. |

#### Human-in-the-loop plan execution

A three-command workflow for executing plans one PR at a time with human review between each step. Each plan gets its own state file in `.private/safe-plan-state/`, so multiple plans can run concurrently in separate sessions.

| Command | Purpose |
|---------|---------|
| `/safe-execute-plan <file>` | Start a plan from `.private/plans/` — implements the next PR, creates it (without merging), automatically runs an **automated review feedback loop** (up to 3 fix cycles with Codex/Devin), then auto-initiates `/safe-check-review` after 60 seconds to await human merge approval. |
| `/safe-check-review [file]` | Check the active plan PR for feedback from codex/devin/humans and CI. Runs an **automated feedback loop** (up to 3 fix cycles): fetches full review data (reviews, inline comments, review threads, reactions, CI checks), determines aggregate status including CI state and human unresolved threads, addresses `changes_requested` by pushing fixes, re-requests reviews, and polls for fresh responses — only concluding approved once all reviewers (bots and humans) and CI are green. Auto-detects the plan if only one is active. |
| `/resume-plan [file]` | Merge the current PR, implement the next one, create it, and stop again. Repeats until the plan is complete. Auto-detects the plan if only one is active. |

**Typical flow:**

1. **`/safe-execute-plan MY_PLAN.md`** — starts the plan, creates PR 1, automatically handles Codex/Devin review feedback (up to 3 cycles), then auto-initiates `/safe-check-review` after 60 seconds
2. **`/resume-plan MY_PLAN.md`** — merge PR 1 (automated reviews already complete), create PR 2, stop
3. Repeat step 2 until the plan is complete

The automated review loop in `/safe-execute-plan` triggers Codex and Devin reviews, waits for their feedback (up to 15 minutes for initial reviews, 10 minutes for subsequent cycles), addresses any `changes_requested` feedback by pushing fixes directly to the PR branch, and re-requests reviews — repeating up to 3 cycles. After the review loop completes, it waits 60 seconds then automatically invokes `/safe-check-review` to hand off to you for merge approval.

Multiple plans can run in parallel — just specify the plan name to disambiguate.

#### Utility

| Command | Purpose |
|---------|---------|
| `/plan-html <topic\|plan-name>` | Create or refresh a rollout plan in `.private/plans/` with both markdown and a polished, review-friendly HTML view (including per-PR file lists). |
| `/release [version]` | Cut a release: pull main, determine/create version tag, generate release notes, publish GitHub Release, and verify CI trigger. |
| `/triage [user\|assistant\|device]` | Search Sentry for recent errors and log reports by user, assistant, or device across both `vellum-assistant-brain` and `vellum-assistant-macos` projects, then cross-reference with Linear issues to produce a triage summary. |
| `/update` | Pull latest from `main`, kill stale processes, rebuild and launch the macOS app. The app manages its own assistant and gateway lifecycle (hatching on first launch). Prints a startup summary. |

#### Review

| Command | Purpose |
|---------|---------|
| `/check-reviews [--namespace NAME]` | Checks for review feedback on unreviewed PRs, assesses feedback contextually (valid, nonsensical, or regression risk), creates follow-up tasks for valid feedback, and halts for user decision on regression risks. When `--namespace` is provided, only PRs whose head branch starts with `swarm/<namespace>/` are processed, and any TODO items added are prefixed with `[<namespace>]`. When `--namespace` is omitted, all PRs are processed, but TODO items are still namespaced if the PR's branch name matches `swarm/<NAME>/...` (the namespace is inferred from the branch). |

#### Typical flow

1. **`/brainstorm`** — generate ideas, approve them into `TODO.md`
2. **`/swarm`** — burn through the TODO list in parallel
3. **`/check-reviews`** — sweep for reviewer feedback
4. **`/swarm`** again — address the feedback

Or for a focused feature: **`/blitz <feature>`** handles all of the above in one shot (plan, issues, swarm, sweep, report). Use **`/safe-blitz <feature>`** for the same workflow but with a feature branch and a final PR for manual review, then **`/safe-blitz-done`** to merge it when ready.

For controlled, sequential plan execution with automated bot reviews and human merge approval: **`/safe-execute-plan <file>`** (creates PR + auto-handles Codex/Devin feedback + auto-initiates `/safe-check-review` after 60s) -> **`/resume-plan`** -> repeat.

All workflows use squash-merge (no merge commits), worktree isolation for parallel work, and track state in `.private/TODO.md` and `.private/UNREVIEWED_PRS.md`.

**Validation**: Slash commands do **not** run tests, type-checking (`tsc`), or linting by default. These steps are only performed when the task specifically requires it (e.g., "fix the type errors", "make the tests pass"). This keeps agent-driven workflows fast for well-scoped changes.

### Release Management

Releases are cut using the `/release` Claude Code command and follow a fully automated pipeline from tag to client update.

#### Cutting a release

Run `/release [version]` in Claude Code. If no version is provided, the patch version is auto-incremented from the latest git tag (e.g. `v0.1.5` becomes `v0.1.6`). The command:

1. Pulls the latest `main` branch
2. Generates release notes from commits since the last tag, grouped into Features, Fixes, and Infrastructure
3. Creates a GitHub Release with the corresponding git tag
4. Confirms the CI build was triggered

#### What happens after a release is created

Creating the GitHub Release triggers three workflows in parallel:

- **Build and Release macOS App** (`build-and-release-macos.yml`): Builds the macOS `.app` from source, compiles the Bun assistant binary, code-signs it with a Developer ID certificate, notarizes it with Apple, creates a DMG installer, and publishes both the DMG and a Sparkle-compatible ZIP + `appcast.xml` to the releases on [vellum-ai/vellum-assistant](https://github.com/vellum-ai/vellum-assistant). This takes ~15-20 minutes.
- **Publish velly to npm** (`publish-velly.yml`): Publishes the `velly` CLI package to npm with provenance.
- **Slack Release Notification** (`slack-release-notification.yml`): Posts a summary message to the releases Slack channel with a threaded changelog.

#### Auto-updates for macOS clients

The macOS app uses [Sparkle](https://sparkle-project.org/) for automatic updates. When a new release is published to the public updates repo, existing client installations detect the update via the `appcast.xml` feed, download the new version, and install it automatically — no manual action required from users. The update check happens periodically in the background while the app is running.

#### First-time installation

New users download the latest DMG from the [releases page](https://github.com/vellum-ai/vellum-assistant/releases/latest), open it, and drag the app to their Applications folder. All subsequent updates are handled automatically by Sparkle.

---

## Telephony STT Architecture

Telephony speech-to-text is driven by the unified `services.stt.provider` configuration. The voice webhook generates provider-conditional TwiML at call setup time, selecting between two Twilio integration paths based on the active STT provider's capabilities.

### Overview

The telephony STT routing resolver (`assistant/src/calls/telephony-stt-routing.ts`) reads `services.stt.provider` from config and maps it to a discriminated strategy:

- **`conversation-relay-native`** — Providers natively supported by Twilio ConversationRelay (Deepgram, Google). TwiML emits `<Connect><ConversationRelay>` with `transcriptionProvider` and `speechModel` attributes. Twilio handles audio ingestion and transcription; the daemon receives transcribed text.

- **`media-stream-custom`** — Providers not natively supported by Twilio (OpenAI Whisper). TwiML emits `<Connect><Stream>` pointing to the daemon's media-stream server. Raw audio flows from Twilio through the gateway's WebSocket proxy to the daemon, which transcribes server-side via the provider's batch API.

Both paths share the same `CallController`, `voice-session-bridge`, and `RunOrchestrator` pipeline downstream of transcription. The only difference is where audio-to-text conversion happens (Twilio-side vs daemon-side).

### Provider-Conditional Routing

| `services.stt.provider` | Strategy                    | TwiML Element                  | Audio Path                                         |
| ------------------------ | --------------------------- | ------------------------------ | -------------------------------------------------- |
| `deepgram`               | `conversation-relay-native` | `<Connect><ConversationRelay>` | Twilio transcribes natively; daemon receives text   |
| `google-gemini`          | `conversation-relay-native` | `<Connect><ConversationRelay>` | Twilio transcribes natively; daemon receives text   |
| `openai-whisper`         | `media-stream-custom`       | `<Connect><Stream>`            | Raw audio to daemon; server-side batch transcription |

Model normalization for Twilio-native providers:
- Deepgram defaults `speechModel` to `"nova-3"` when unset.
- Google leaves `speechModel` undefined when unset. The legacy Deepgram default `"nova-3"` is treated as unset for Google so workspaces that switched providers do not send a Deepgram model name to Google's API.

Workspace migration `034-remove-calls-voice-transcription-provider` preserves existing Google STT preferences from the former `calls.voice.transcriptionProvider` key into `services.stt.provider`.

### Troubleshooting Matrix

| Symptom | Likely Provider | Check | Expected Log |
| ------- | --------------- | ----- | ------------ |
| Call connects but no transcription | Deepgram / Google | Verify Deepgram or Google API key is configured in credential store | `[twilio-routes] telephony STT strategy resolved: conversation-relay-native` |
| Call connects, TTS works, but STT silent | OpenAI Whisper | Verify OpenAI API key is configured; check media-stream server is reachable via gateway | `[twilio-routes] telephony STT strategy resolved: media-stream-custom` |
| TwiML error / call drops immediately | Any | Check `services.stt.provider` is a recognized catalog entry | `[twilio-routes] unknown STT provider — cannot resolve telephony routing` |
| Deepgram transcription uses wrong model | Deepgram | The routing resolver defaults Deepgram to `nova-3`; custom model overrides are set via `services.stt.providers.deepgram` config | `speechModel="nova-3"` in TwiML output |
| Google transcription sends Deepgram model | Google | Model normalization should suppress `nova-3` for Google; verify migration 034 ran | `speechModel` attribute absent from TwiML |
| Media-stream WebSocket fails to connect | OpenAI Whisper | Verify gateway `/webhooks/twilio/media-stream` route is deployed and reachable | `[gateway] media-stream WebSocket proxy connected` |
| Audio heard but transcription garbled | OpenAI Whisper | Check audio transcode pipeline (`media-stream-audio-transcode.ts`); verify sample rate matches provider expectations | `[media-stream-stt-session] transcription result` |

### Twilio Media-Stream Troubleshooting

This section covers debugging media-stream calls that use the `media-stream-custom` STT strategy (OpenAI Whisper). The media-stream path handles raw audio ingestion, speech-aware turn segmentation, and server-side transcription.

#### Key Log Markers

Search daemon logs for the `media-stream-server` and `media-stt-session` logger categories. Each log entry includes `callSessionId` for correlation.

| Log message | Logger | Meaning |
| --- | --- | --- |
| `Media stream session started` | `media-stream-server` | Stream `start` event received; controller created |
| `Media-stream barge-in accepted — cleared outbound audio` | `media-stream-server` | Caller spoke while assistant was speaking; turn interrupted |
| `Media-stream barge-in ignored — assistant not speaking` | `media-stream-server` | Inbound audio arrived but assistant was idle/processing; no interrupt |
| `Media stream stop event received` | `media-stream-server` | Twilio sent `stop`; call is ending |
| `Media stream transport closed — session diagnostics` | `media-stream-server` | WebSocket closed; includes `turnStarts`, `transcriptFinalsProduced`, `bargeInAccepted`, `bargeInIgnored`, `terminationReason` |
| `Media stream call session destroyed` | `media-stream-server` | Full teardown; includes session-lifetime diagnostic counters |
| `Media stream STT session started` | `media-stt-session` | STT session initialized with stream metadata |
| `Barge-in ignored — assistant not speaking` | `call-controller` | Controller received barge-in but was idle or processing |
| `Barge-in accepted — interrupting assistant speech` | `call-controller` | Controller was speaking and accepted the interrupt |

#### Failure Class Mapping

| Symptom | Likely failure class | Diagnostic steps |
| --- | --- | --- |
| **Connected but no reply** | False barge-in abort: initial inbound audio interrupted the first turn before the assistant could respond | Check logs for `barge-in accepted` immediately after `session started`. If present, the gating fix is not active. Verify `handleBargeIn` (not `handleInterrupt`) is called from `handleSpeechStart`. |
| **Connected but no reply (no barge-in)** | Handshake/setup failure: `start` event never arrived or setup policy denied the call | Check for `Media stream session started` log. If absent, verify gateway WebSocket proxy is forwarding to the daemon. Check for `setup denied` events. |
| **Call active but no transcript** | Turn segmentation not detecting speech-bearing chunks | Check `turnStarts` and `transcriptFinalsProduced` in the session diagnostics log. If `turnStarts=0`, the speech-aware detector is not receiving speech-bearing chunks. Verify audio encoding and energy levels. |
| **Transcript only at hangup** | Turn boundaries not detected mid-call; only `forceEnd` at stream stop produced a transcript | Check `transcriptFinalsProduced` — if it equals 1 and the call was long, speech-to-silence transitions are not being detected. Verify `detectSpeechActivity` thresholds match the audio characteristics. |
| **Immediate abort after connect** | Controller destroyed before first turn completes | Check for `Media stream call session destroyed` appearing within 1-2 seconds of `session started`. Cross-reference with `terminationReason` in transport-close diagnostics. |
| **Repeated bogus transcriptions** | Silent/noise frames classified as speech | Check `turnStarts` — if much higher than expected, the speech energy threshold is too low. Tune `SPEECH_ENERGY_THRESHOLD` in `media-stream-stt-session.ts`. |

#### Session Diagnostic Fields

The `Media stream transport closed — session diagnostics` and `Media stream call session destroyed` log entries include:

- **`turnStarts`** — Number of turn-start transitions detected by the turn detector.
- **`transcriptFinalsProduced`** — Number of non-empty transcripts delivered to the controller.
- **`bargeInAccepted`** — Interrupts that fired (assistant was speaking).
- **`bargeInIgnored`** — Interrupts that were suppressed (assistant idle/processing).
- **`terminationReason`** — `normal_stop` (clean close code 1000) or `premature_abort` (abnormal close).

---

## Conversation STT Streaming Operator Runbook

This runbook covers debugging and validating real-time STT streaming for conversation chat message capture on macOS and iOS. The streaming path uses a WebSocket session from the native client through the gateway to the daemon, where a provider-specific streaming adapter transcribes audio in real time.

For full architectural details, see the "Conversation streaming boundary" section in [`assistant/ARCHITECTURE.md`](../assistant/ARCHITECTURE.md).

### Architecture Summary

```
macOS/iOS Client                     Gateway                              Daemon (Runtime)
─────────────────                    ───────                              ────────────────
STTStreamingClient  ──WSS──>  stt-stream-websocket.ts  ──WS──>  http-server.ts /v1/stt/stream
  (URLSessionWebSocketTask)    (edge JWT auth → service token)     (SttStreamSession)
                                                                        │
                                                            resolveStreamingTranscriber()
                                                                        │
                                                         ┌──────────────┼──────────────┐
                                                         │              │              │
                                                  DeepgramRealtime  GoogleGemini   OpenAIWhisper
                                                  Transcriber       Streaming      Streaming
                                                  (realtime-ws)     Transcriber    Transcriber
                                                                    (incr-batch)   (incr-batch)
                                                         │              │              │
                                                  WSS to Deepgram  HTTP polling   HTTP polling
                                                  /v1/listen       to Gemini API  to Whisper API
```

**Provider support matrix:**

| Provider        | `conversationStreamingMode` | Streaming adapter | Batch fallback |
| --------------- | --------------------------- | ----------------- | -------------- |
| `deepgram`      | `realtime-ws`               | Yes               | Yes            |
| `google-gemini` | `incremental-batch`         | Yes               | Yes            |
| `openai-whisper` | `incremental-batch`        | Yes               | Yes            |

### Debugging Stream Sessions

#### 1. Verify provider supports streaming

Check the configured STT provider in the assistant's config (`services.stt.provider`). All three providers (`deepgram`, `google-gemini`, and `openai-whisper`) support conversation streaming. The client checks `STTProviderRegistry.isStreamingAvailable` before opening a WebSocket — if the provider's `conversationStreamingMode` is `"none"`, streaming sessions are not attempted.

#### 2. Verify credentials are configured

The daemon resolves credentials via `resolveStreamingTranscriber()` in `src/providers/speech-to-text/resolve.ts`. If the API key for the configured provider is not set, the function returns `null` and the session emits an `error` event with category `provider-error` followed by `closed`.

To validate credentials without starting a session, call `resolveConversationStreamingSttCapability()` from the same module. It returns a discriminated union with `status: "supported"`, `"unsupported"`, `"unconfigured"`, or `"missing-credentials"`.

#### 3. Check gateway logs for upstream connection

The gateway proxy (`stt-stream-websocket.ts`) logs:

- **On downstream connect:** `"Opening upstream STT stream WS to runtime"` with `provider`, `mimeType`, `sampleRate` fields (token redacted).
- **On upstream open:** `"Upstream STT stream WS connected"` with `provider` field.
- **On upstream close:** `"Upstream STT stream WS closed"` with `code` and `provider` fields.
- **On upstream error:** `"Upstream STT stream WS error"` with `error` and `provider` fields.
- **On downstream close:** `"STT stream downstream WS closed"` with `code`, `reason`, `provider` fields.
- **Buffer overflow:** `"STT stream pending message buffer overflow"` -- more than 100 messages buffered before upstream connects. Downstream is closed with code 1008.

#### 4. Check daemon logs for session lifecycle

The daemon session orchestrator (`stt-stream-session.ts`, logger: `stt-stream-session`) logs:

- **Session started:** `"STT stream session started"` with `provider` field.
- **Unsupported provider:** `"Streaming transcriber unavailable for provider"` -- `resolveStreamingTranscriber()` returned `null`.
- **Start failure:** `"Failed to start STT stream session"` with `provider` and `error` fields.
- **WebSocket closed:** `"STT stream WebSocket closed"` with `provider`, `code`, `reason` fields.
- **Idle timeout:** `"STT stream session idle timeout"` with `provider` field -- no client message received within 60 seconds.
- **Session destroyed:** `"STT stream session destroyed"` -- runtime shutdown cleanup.

#### 5. Check provider-specific adapter logs

**Deepgram (`deepgram-realtime`, logger: `deepgram-realtime`):**

- `"Opening Deepgram realtime session"` -- WebSocket URL (token redacted).
- `"Deepgram realtime session opened"` -- connection established.
- `"Stopping Deepgram realtime session"` -- `CloseStream` sent.
- `"Deepgram realtime session closed normally"` -- clean close after stop.
- `"Deepgram realtime session closed unexpectedly"` with `code`, `reason` -- provider-side disconnect.
- `"Deepgram realtime WebSocket error"` -- provider WebSocket error event.
- `"Deepgram realtime backpressure: dropping audio frame"` -- outbound buffer > 1 MiB.
- `"Deepgram realtime inactivity timeout"` -- no provider message for 30 seconds.
- `"Deepgram realtime connect timeout"` -- WebSocket did not open within 10 seconds.
- `"Deepgram realtime close grace timeout"` -- provider did not close within 5 seconds after `CloseStream`.

**Google Gemini (`google-gemini-stream`):** This adapter does not have its own logger category (uses default module-level logging). Key indicators are `error` events with `category: "provider-error"` in the session event stream. Poll errors during active streaming are non-fatal (logged as transient); only the final batch request on `stop()` is critical.

### Log Anchors

These are the key strings to search for when triaging streaming STT issues. Search daemon logs for the `stt-stream-session` and `deepgram-realtime` logger categories.

| Log message                                         | Logger                | Meaning                                              |
| --------------------------------------------------- | --------------------- | ---------------------------------------------------- |
| `STT stream session started`                        | `stt-stream-session`  | Session initialized and `ready` event sent to client |
| `STT stream session idle timeout`                   | `stt-stream-session`  | No client activity for 60 seconds                    |
| `STT stream WebSocket closed`                       | `stt-stream-session`  | Client or transport closed the connection            |
| `Streaming transcriber unavailable for provider`    | `stt-stream-session`  | Provider does not support streaming                  |
| `Failed to start STT stream session`                | `stt-stream-session`  | Transcriber `start()` threw (auth, network, etc.)    |
| `Opening Deepgram realtime session`                 | `deepgram-realtime`   | Deepgram WebSocket connection attempt                |
| `Deepgram realtime session closed unexpectedly`     | `deepgram-realtime`   | Provider-side disconnect with non-normal code        |
| `Deepgram realtime connect timeout`                 | `deepgram-realtime`   | Could not connect to Deepgram within 10 seconds      |
| `Deepgram realtime inactivity timeout`              | `deepgram-realtime`   | No data from Deepgram for 30 seconds                 |
| `Opening upstream STT stream WS to runtime`         | `stt-stream-ws`       | Gateway opening upstream connection to daemon        |
| `STT stream WS: authentication failed`              | `stt-stream-ws`       | Client edge JWT validation failed                    |
| `STT stream pending message buffer overflow`        | `stt-stream-ws`       | Gateway buffer exceeded 100 messages                 |

### Expected Event Sequences

**Successful session (Deepgram):**

```
Client -> Gateway: WSS upgrade with ?provider=deepgram&mimeType=audio/pcm&sampleRate=16000
Gateway -> Daemon: WS upgrade to /v1/stt/stream with service token
Daemon: resolveStreamingTranscriber() -> DeepgramRealtimeTranscriber
Daemon -> Deepgram: WSS to wss://api.deepgram.com/v1/listen?model=nova-2&...
Deepgram -> Daemon: WS open
Daemon -> Client: {"type":"ready","provider":"deepgram"}
Client -> Daemon: binary audio frames (16-bit PCM)
Deepgram -> Daemon: {"type":"Results","is_final":false,...}  ->  Daemon -> Client: {"type":"partial","text":"hello","seq":0}
Deepgram -> Daemon: {"type":"Results","is_final":true,...}   ->  Daemon -> Client: {"type":"final","text":"hello world","seq":1}
Client -> Daemon: {"type":"stop"}
Daemon -> Deepgram: {"type":"CloseStream"}
Deepgram -> Daemon: WS close 1000
Daemon -> Client: {"type":"closed","seq":2}
Daemon: WS close 1000
```

**Successful session (Google Gemini):**

```
Client -> Gateway: WSS upgrade with ?provider=google-gemini&mimeType=audio/webm
Gateway -> Daemon: WS upgrade to /v1/stt/stream with service token
Daemon: resolveStreamingTranscriber() -> GoogleGeminiStreamingTranscriber
Daemon -> Client: {"type":"ready","provider":"google-gemini"}
Client -> Daemon: binary audio frames
Daemon: (accumulates audio, polls Gemini API every ~1 second)
Daemon -> Gemini API: POST models.generateContent (full accumulated audio)
Gemini API -> Daemon: transcript text
Daemon -> Client: {"type":"partial","text":"hello world","seq":0}
Client -> Daemon: {"type":"stop"}
Daemon -> Gemini API: POST models.generateContent (final complete audio)
Gemini API -> Daemon: final transcript text
Daemon -> Client: {"type":"final","text":"hello world how are you","seq":1}
Daemon -> Client: {"type":"closed","seq":2}
Daemon: WS close 1000
```

**Auth failure:**

```
Client -> Gateway: WSS upgrade with invalid/expired edge JWT
Gateway: "STT stream WS: authentication failed"
Gateway -> Client: HTTP 401 Unauthorized (no WebSocket upgrade)
Client: STTStreamFailure.rejected(statusCode: 401)
Client: Falls back to batch STT path
```

**Unsupported provider (hypothetical provider with `conversationStreamingMode: "none"`):**

```
Client: STTProviderRegistry.isStreamingAvailable -> false (provider has conversationStreamingMode "none")
Client: Does not open WebSocket; uses batch STT path directly
```

**Provider disconnect mid-session (Deepgram):**

```
(session in progress, audio flowing)
Deepgram -> Daemon: WS close 1008 (auth error)
Daemon: "Deepgram realtime session closed unexpectedly" code=1008
Daemon -> Client: {"type":"error","category":"auth","message":"Deepgram WebSocket closed (code=1008, ...)","seq":N}
Daemon -> Client: {"type":"closed","seq":N+1}
Client: streamingFailed = true / isStreamingActive = false
Client: Falls back to batch STT on recording stop
```

### Common Failure Scenarios

| Symptom | Likely cause | Diagnosis |
| --- | --- | --- |
| No streaming session opened | Provider has `conversationStreamingMode: "none"` or STT not configured | Check `services.stt.provider` config; check `STTProviderRegistry.isStreamingAvailable` |
| `ready` event never received | Gateway cannot reach daemon, or daemon failed to start transcriber | Check gateway logs for upstream connection errors; check daemon logs for `"Failed to start STT stream session"` |
| Auth failure (HTTP 401 before upgrade) | Expired or invalid edge JWT; no `Authorization` header or `token` query param | Check gateway `stt-stream-ws` logs for `"authentication failed"` with reason |
| Partials but no final (Deepgram) | Deepgram session closed before client sent `stop` | Check for `"Deepgram realtime session closed unexpectedly"` or `"inactivity timeout"` |
| Slow partials (Google Gemini / OpenAI Whisper) | Expected: incremental-batch polls every ~1 second | This is by design; both providers use incremental-batch mode. Reduce poll interval only for testing via stream options |
| Idle timeout after 60 seconds | Client stopped sending audio without sending `stop` event | Check client-side audio pipeline; ensure `stop` event is sent on recording end |
| Buffer overflow (gateway) | Upstream daemon connection slow to establish; client sending audio too fast | Check gateway `"STT stream pending message buffer overflow"` log; check daemon startup time |
| Empty final transcript | Audio too short, no speech detected, or provider returned empty | Check audio format (mimeType, sampleRate); try with known-good audio |

### Rollout Validation Checklist

Use this checklist when rolling out conversation STT streaming to macOS and iOS.

**macOS conversation chat capture:**

- [ ] Configure `services.stt.provider` to `deepgram`. Record a conversation message. Verify partial transcripts appear in real time in the chat composer. Verify the final transcript matches spoken audio.
- [ ] Configure `services.stt.provider` to `google-gemini`. Record a conversation message. Verify partial transcripts appear (with ~1-second latency). Verify the final transcript matches spoken audio.
- [ ] Configure `services.stt.provider` to `openai-whisper`. Record a conversation message. Verify partial transcripts appear (with ~1-second latency, incremental-batch mode). Verify the final transcript matches spoken audio.
- [ ] With `deepgram` configured, simulate a network disconnect mid-recording (e.g. disable WiFi). Verify the client falls back to batch STT and produces a final transcript.
- [ ] With `deepgram` configured, remove the Deepgram API key. Start a recording. Verify the session fails gracefully and batch STT is used.
- [ ] Verify dictation mode (not conversation) still uses the batch STT path regardless of streaming availability.

**iOS conversation chat capture:**

- [ ] Configure `services.stt.provider` to `deepgram`. Record via the input bar. Verify streaming partials update the text field. Verify the final transcript is committed via `onVoiceResult`.
- [ ] Configure `services.stt.provider` to `google-gemini`. Record via the input bar. Verify incremental partials appear. Verify the final transcript is committed.
- [ ] Configure `services.stt.provider` to `openai-whisper`. Record via the input bar. Verify incremental partials appear. Verify the final transcript is committed.
- [ ] Simulate streaming failure (e.g. bad API key). Verify `resolveTranscriptWithServiceFirst()` fires and batch STT produces a result.
- [ ] Verify auto-stop coordination: when auto-stop fires and streaming is active, verify the streaming final takes precedence. When streaming has closed/failed before auto-stop, verify batch fallback is triggered.

**Cross-platform:**

- [ ] Verify no regressions in voice mode (OpenAIVoiceService) -- voice mode does not use conversation streaming.
- [ ] Verify gateway logs show `"Upstream STT stream WS connected"` for each streaming session.
- [ ] Verify daemon logs show `"STT stream session started"` with the correct provider.
- [ ] Verify no `<ConversationRelay>` or telephony STT paths are affected by conversation streaming changes.
