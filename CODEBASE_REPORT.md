# Vellum Assistant — Codebase Architecture Report

> Generated 2026-04-05 from commit `4d6210171` on `main`.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Project Structure](#2-project-structure)
3. [Tech Stack and Dependencies](#3-tech-stack-and-dependencies)
4. [Core Architecture](#4-core-architecture)
5. [API Surface](#5-api-surface)
6. [Testing](#6-testing)
7. [Code Quality Signals](#7-code-quality-signals)
8. [Contribution Surface](#8-contribution-surface)
9. [Gaps and Opportunities](#9-gaps-and-opportunities)

---

## 1. Project Overview

Vellum Assistant is an open-source (MIT), self-hosted personal AI assistant that learns user preferences, remembers context, and improves over time. It's a multi-service monorepo with:

- A **Bun + TypeScript** backend (assistant daemon, gateway, credential executor)
- **Swift** native clients (macOS and iOS)
- A **Chrome extension** for browser integration
- A **skill system** with 39 first-party skills (weather, DoorDash, Notion, etc.)
- Multi-channel communication (Telegram, Slack, WhatsApp, voice/Twilio, email)
- Multi-provider LLM support (Anthropic Claude, OpenAI, Google Gemini, Ollama)

**Version:** 0.6.0  
**Repository:** `vellum-ai/vellum-assistant`  
**License:** MIT (copyright 2025 Vellum AI)

---

## 2. Project Structure

### 2.1 Top-Level Organization

```
vellum-assistant/
├── assistant/          # Core daemon — conversation engine, memory, tools, skills, providers
├── gateway/            # Public ingress — webhook handlers, auth, feature flags
├── cli/                # Terminal UI — instance management (hatch, wake, sleep, etc.)
├── credential-executor/# Isolated credential handling — JSON-RPC/HTTP service
├── clients/            # Native apps — macOS (AppKit+SwiftUI), iOS (SwiftUI), Chrome ext
├── packages/           # Shared internal packages (ces-contracts, credential-storage, egress-proxy)
├── skills/             # First-party skill catalog (39 skills, each SKILL.md + optional scripts)
├── meta/               # Cross-system metadata — feature flag registry, bin entry points
├── scripts/            # CI/CD scripts — releases, Docker publishing, affected-test detection
├── benchmarking/       # Performance benchmarks — gateway load tests, evaluation dimensions
├── docs/               # Internal developer reference (docs/internal-reference.md, 39KB)
├── assets/             # Banner images and promotional graphics
├── .github/            # CI workflows, CODEOWNERS, issue templates
└── .claude/            # Claude Code configuration — hooks, skills, settings
```

### 2.2 File Counts by Area

| Directory | Source Files | Test Files | Language |
|-----------|-------------|------------|----------|
| `assistant/src/` | ~1,324 `.ts` | ~693 `.test.ts` | TypeScript |
| `gateway/src/` | ~174 `.ts` | included above | TypeScript |
| `cli/src/` | ~75 `.ts`/`.tsx` | included above | TypeScript + React (Ink) |
| `credential-executor/src/` | ~50 `.ts` | included above | TypeScript |
| `clients/` (non-test) | ~675 `.swift` | ~163 test `.swift` | Swift |
| `skills/` | 35 `SKILL.md` files | — | Markdown + TypeScript scripts |

### 2.3 Hand-Written vs. Generated/Vendored Code

| Category | Location | Notes |
|----------|----------|-------|
| **Hand-written** | `assistant/`, `gateway/`, `cli/`, `credential-executor/`, `clients/macos/`, `clients/ios/`, `skills/` | All core logic |
| **Generated** | `clients/shared/Network/Generated/GeneratedAPITypes.swift` | Auto-generated from TypeScript message protocol contract |
| **Vendored** | `clients/.periphery_baseline.json` (137KB) | Dead code analysis baseline for Periphery |
| **Bundled copies** | `assistant/src/config/feature-flag-registry.json`, `gateway/src/feature-flag-registry.json` | Synced from `meta/feature-flags/feature-flag-registry.json` at build time via `meta/feature-flags/sync-bundled-copies.ts` |

### 2.4 Monorepo / Workspace Configuration

This is **not** a workspace-based monorepo (no npm/bun workspaces, no lerna, no nx, no turbo). Instead, packages are linked via `setup.sh` which runs `bun link` for each package. The `meta/` package acts as a meta-aggregator, importing all services and exposing them through `bin/vellum.js` and `bin/assistant.js`.

---

## 3. Tech Stack and Dependencies

### 3.1 Runtime and Language

| Component | Runtime | Language | Version Constraint |
|-----------|---------|----------|--------------------|
| Assistant daemon | Bun 1.3.9 | TypeScript | Node 22 (`.nvmrc`) |
| Gateway | Bun | TypeScript | — |
| CLI | Bun | TypeScript + React (Ink) | — |
| Credential Executor | Bun | TypeScript | — |
| macOS client | Native (SPM) | Swift | macOS 15.0+ |
| iOS client | Native (SPM) | Swift | iOS 17+ |
| Chrome extension | Browser | JavaScript | — |

### 3.2 Key Dependencies

#### Assistant (`assistant/package.json`)

| Dependency | Role |
|------------|------|
| `@anthropic-ai/sdk` | Anthropic Claude LLM provider |
| `openai` | OpenAI LLM + embeddings provider |
| `@google/genai` | Google Gemini LLM + embeddings provider |
| `drizzle-orm` + `better-sqlite3` | SQLite ORM for structured persistence |
| `@qdrant/js-client-rest` | Qdrant vector database client (memory recall) |
| `pino` + `pino-pretty` | Structured logging |
| `zod` | Runtime schema validation |
| `playwright` | Browser automation (browser tool) |
| `@modelcontextprotocol/sdk` | MCP server support |
| `@sentry/bun` | Error tracking |

#### Gateway (`gateway/package.json`)

Minimal: `pino`, `uuid`, `file-type`, `minimatch` — deliberate thin layer.

#### CLI (`cli/package.json`)

| Dependency | Role |
|------------|------|
| `ink` 6.7.0 + `react` 19.2.4 | Terminal UI framework |
| `chalk` | Colored terminal output |
| `qrcode-terminal` + `jsqr` + `pngjs` | QR code for device pairing |
| `nanoid` | Unique ID generation |

#### Swift Clients (`clients/Package.swift`)

| Dependency | Role |
|------------|------|
| `sentry-cocoa` 8.0+ | Crash reporting |
| `Sparkle` 2.0+ | macOS app auto-updates |
| `SwiftTerm` 1.0+ | Terminal emulator view |

### 3.3 Build System

- **TypeScript**: No bundler — Bun runs `.ts` files directly. `tsc --noEmit` for type checking only.
- **Swift/macOS**: `build.sh` in `clients/` — compiles daemon binary, builds app bundle, creates DMG.
- **Docker**: Multi-stage Dockerfile (not included in repo root, referenced in scripts). Separate containers for assistant, gateway, CES, and Qdrant.
- **CI**: GitHub Actions workflows for each service — see `.github/workflows/`.

---

## 4. Core Architecture

### 4.1 Service Topology

```
                     ┌─────────────────┐
                     │  macOS / iOS    │
                     │  Native Client  │
                     └────────┬────────┘
                              │ HTTP + SSE
                              ▼
┌──────────┐  webhooks  ┌──────────┐  HTTP  ┌──────────────┐
│ External │───────────▶│ Gateway  │───────▶│  Assistant    │
│ Services │            │ :7830    │        │  Daemon :7821 │
│ (Telegram│◀───────────│          │        │               │
│  Twilio  │  delivery  └──────────┘        │  ┌──────────┐ │
│  Slack)  │                                │  │ Agent    │ │
└──────────┘                                │  │ Loop     │ │
                                            │  └──────────┘ │
                                            │  ┌──────────┐ │
                                            │  │ Memory   │ │
                                            │  │ SQLite + │ │
                                            │  │ Qdrant   │ │
                                            │  └──────────┘ │
                                            └───────┬───────┘
                                                    │ stdio JSON-RPC
                                                    ▼
                                            ┌───────────────┐
                                            │  Credential   │
                                            │  Executor     │
                                            │  (CES)        │
                                            └───────────────┘
```

### 4.2 Entry Point and Startup Flow

1. **`meta/bin/vellum.js`** — Global CLI entry point, dispatches to sub-commands.
2. **`cli/src/index.ts`** — Command registry (23 commands: `hatch`, `wake`, `sleep`, `ps`, `client`, etc.).
3. **`vellum hatch`** — Provisions a new instance under `~/.vellum/instances/<name>/`.
4. **`vellum wake`** — Starts the assistant daemon, gateway, and Qdrant sidecar.
5. **`assistant/src/index.ts`** — Builds CLI program via Commander.js (`src/cli/program.ts`).
6. **`assistant/src/daemon/main.ts`** → `runDaemon()` in `daemon/lifecycle.ts` — Core daemon startup.
7. **`assistant/src/runtime/http-server.ts`** — Bun HTTP + WebSocket server on port 7821.
8. **`gateway/src/index.ts`** — Gateway HTTP server on port 7830.

### 4.3 Major Subsystems

#### Conversation Engine (`assistant/src/daemon/`)

- **`conversation.ts`** (~1,146 lines) — Core stateful container for each conversation session. Holds message history, agent loop, tool executor, provider, message queue, context window manager, trust context, and channel capabilities.
- **`conversation-process.ts`** — Message processing pipeline: queue drain → `processMessage()` → agent loop → event emission.
- **`conversation-agent-loop.ts`** — Delegates to `AgentLoop`, captures events, streams to client.
- **`message-protocol.ts`** — Union types `ClientMessage` and `ServerMessage` composed from 25+ domain-specific message files in `message-types/`.

#### Agent Loop (`assistant/src/agent/loop.ts`)

The LLM interaction orchestrator. Key event types: `text_delta`, `thinking_delta`, `message_complete`, `tool_use`, `tool_output_chunk`, `tool_result`, `usage`, `error`. Config includes `maxTokens`, `effort`, `thinking`, `speed`, `toolChoice`, `cacheTtl`.

#### Tool System (`assistant/src/tools/`)

- **`registry.ts`** — Global `Map<string, Tool>` with `registerTool()`, `registerSkillTools()`, `unregisterSkillTools()`. Skill reference counting for lazy unloading.
- **`tool-manifest.ts`** — Declares all tools. Core tools (eager): `bash`, `file_read`, `file_write`, `file_edit`, `file_list`, `web_search`, `web_fetch`, `skill_execute`, `skill_load`, `request_system_permission`, `notify_parent`. Explicit tools: `remember`, `recall`, `credential_store`. CES tools conditionally registered.
- **`executor.ts`** — `ToolExecutor.execute(name, input, context)`: pre-execution gates (abort, guardian policy, allowed-tool-set, CES lockdown) → permission checking → secret detection → timeout management → output sanitization → result truncation.
- **Core tool implementations**: `terminal/shell.ts` (bash), `filesystem/` (read/write/edit/list), `network/` (web-fetch, web-search), `skills/` (skill_execute, skill_load), `memory/register.ts` (remember, recall).
- **Host Proxy System**: `HostBashProxy`, `HostFileProxy`, `HostCuProxy` — delegate execution to the desktop client for sandboxed environments.

#### Skill System (`skills/` + `assistant/src/skills/` + `assistant/src/tools/skills/`)

**Format**: Each skill is a directory containing `SKILL.md` (YAML frontmatter + Markdown instructions) + optional `TOOLS.json` (tool definitions) + optional `scripts/`.

**Discovery and Loading**:
1. `skill_load(skill="weather")` → search catalog → load `SKILL.md` → parse frontmatter
2. Feature flag check → include graph validation → auto-install missing includes
3. Inline command expansion (`!`command``) rendered in sandbox
4. `registerSkillTools()` adds tool definitions to global registry
5. `skill_execute(tool="...", input={...})` dispatches to host or sandbox runner

**Key files**:
- `skills/catalog.json` — Master catalog indexing all 39 skills
- `assistant/src/tools/skills/load.ts` — `SkillLoadTool` (lines 127–556)
- `assistant/src/tools/skills/execute.ts` — `SkillExecuteTool`
- `assistant/src/tools/skills/skill-tool-factory.ts` — Creates `Tool` from `SkillToolEntry`
- `assistant/src/tools/skills/skill-script-runner.ts` — Script execution
- `assistant/src/tools/skills/script-contract.ts` — `SkillToolScript` interface (`run(input, context) → ToolExecutionResult`)
- `assistant/src/skills/inline-command-expansions.ts` — Inline command parsing
- `assistant/src/skills/version-hash.ts` — Deterministic version hashing for approval tracking

**39 First-Party Skills**: agentmail, amazon, api-mapping, cli-discover, deploy-fullstack-vercel, document-writer, doordash, elevenlabs-voice, email-setup, fish-audio, frontend-design, guardian-verify-setup, influencer, macos-automation, mcp-setup, notion, oura, oura-setup, public-ingress, restaurant-reservation, screen-recording, self-upgrade, slack-app-setup, start-the-day, telegram-setup, time-based-actions, twilio-setup, typescript-eval, vellum-avatar, vellum-oauth-integrations, vellum-self-knowledge, vercel-token-setup, voice-setup, watch-together, weather.

Plus internal bundled skills in `assistant/src/config/bundled-skills/`: browser, google-calendar, tasks, phone-calls, voice-setup, contacts, guardian-verify-setup, media-processing.

#### Memory System (`assistant/src/memory/`)

- **SQLite** (via Drizzle ORM) at `~/.vellum/workspace/data/db/assistant.db` — Tables: conversations, messages, tool_invocations, memory_segments, memory_items, memory_sources, memory_summaries, memory_embeddings, memory_jobs, attachments, channel_inbound_events, conversation_keys, reminders, cron_jobs, cron_runs, tasks, task_runs, work_items, contacts, delivery records, guardian approvals/actions.
- **Qdrant** vector database (managed sidecar at `~/.vellum/workspace/data/qdrant/` or external) — Used for semantic memory recall.
- **Hybrid Retrieval**: Dense (vector embeddings) + sparse (lexical) search with reciprocal rank fusion.
- **Embedding backends**: OpenAI (`embedding-openai.ts`), Gemini (`embedding-gemini.ts`), local (`embedding-local.ts`), Ollama (`embedding-ollama.ts`). Dynamically selected via `embedding-runtime-manager.ts`.
- **Memory indexer** (`indexer.ts`): Structured extraction of identity facts, preferences, projects, events with source attribution and per-item TTL (identity 6mo, events 3d).
- **Graph memory**: Knowledge graph representation in `memory/graph/` — entity extraction, relation storage, scoring, triggers, decay.
- **Circuit breaker** (`qdrant-circuit-breaker.ts`): Graceful degradation when vector store is unavailable.

#### Provider Abstraction (`assistant/src/providers/`)

- Entry point: `getConfiguredProvider()` from `provider-send-message.ts`.
- Providers: Anthropic Claude, OpenAI, Google Gemini, Ollama.
- **Model Intent** system: `'latency-optimized'`, `'quality-optimized'`, `'vision-optimized'` — not hardcoded model IDs.
- Architectural guard: `no-direct-anthropic-sdk-imports.test.ts` enforces that no code outside `providers/` imports the Anthropic SDK directly.

#### Permissions & Approvals (`assistant/src/permissions/`, `assistant/src/approvals/`)

- **Guardian System**: Actor identity (guardian, trusted, unknown) resolved once, enforced everywhere.
- **Trust Engine** (`runtime/actor-trust-resolver.ts`): `TrustClass` enum determines execution restrictions.
- **Permission Prompter** (`permissions/prompter.ts`): Interactive approval gateway for risky operations.
- **Canonical Request System** (`runtime/confirmation-request-guardian-bridge.ts`): Bridges in-process confirmations to guardian approval UI.
- **Scoped Approval Grants**: Persistent and temporary grants for elevated actions.

#### Context Window Management (`assistant/src/context/`)

- `window-manager.ts` — Token budget estimation, context compaction, checkpointing.
- `token-estimator.ts` — Per-model token prediction including tool definitions, cache credits.
- `tool-result-truncation.ts` — Clips oversized tool outputs to preserve context budget.

#### Channels (`assistant/src/channels/`)

Defined types: `telegram`, `phone`, `vellum`, `whatsapp`, `slack`, `email`. Interface types: `macos`, `ios`, `cli`. Per-channel adapters handle message formatting, delivery, retry logic.

### 4.4 Lifecycle of a User Message

```
1. Client sends POST /v1/messages {conversationId, content, attachments}
2. Route handler (conversation-routes.ts:905) validates JWT auth
3. Message queued via MessageQueue (returns 202 immediately)
4. Background: conversation.drainQueue() → processMessage()
5. Memory recall injected (hybrid dense+sparse search)
6. Context window budgeted (token estimation)
7. Agent loop runs:
   a. Build prompt with system instructions + context + history
   b. Send to LLM provider (streaming)
   c. Stream text_delta / thinking_delta events to client via SSE
   d. For tool_use events:
      - Pre-execution gates (guardian policy, permissions)
      - ToolExecutor.execute() runs the tool
      - Stream tool_output_chunk events
      - Emit tool_result
   e. Loop until stop_reason=end_turn
8. Save message to SQLite, update conversation state
9. Emit message_complete + usage stats via AssistantEventHub
10. Client receives events on GET /v1/events (SSE stream)
```

### 4.5 Credential Isolation (CES)

The Credential Execution Service enforces hard process-boundary isolation:

- **Local mode**: Child process, stdio JSON-RPC (`credential-executor/src/main.ts`)
- **Managed mode**: Sidecar container, Unix socket (`credential-executor/src/managed-main.ts`)
- **Execution pipeline**: Bundle validation → profile validation → grant enforcement → workspace staging → credential materialization → egress proxy startup → auth adapter construction → command execution → output copyback → cleanup
- **Grant system**: Persistent grants (`~/.vellum/protected/ces/grants.json`) and temporary in-memory grants
- **Auth adapters**: `env_var`, `temp_file`, `credential_process`
- **Shared packages**: `ces-contracts` (wire protocol), `credential-storage` (encryption), `egress-proxy` (network allowlists)

### 4.6 Native Clients

#### macOS (`clients/macos/`)
- AppKit + SwiftUI, service container pattern (`AppServices`)
- Features: Menu bar, main chat window, settings, computer use (AXUIElement, ScreenCaptureKit, CGEvent injection), voice, terminal, ambient agent, browser PiP, guardian approval UI
- Communication: HTTP + SSE to local daemon via `GatewayHTTPClient` and `EventStreamClient`

#### iOS (`clients/ios/`)
- SwiftUI only, cloud-only or HTTP gateway pairing
- QR code pairing with macOS instance
- Subset of features (no computer use due to sandbox restrictions)

#### Shared (`clients/shared/`)
- 286 Swift files: network clients, design system (`VColor`, `VFont`, `VSpacing`), chat implementation (`ChatViewModel`, `ChatMessage`), feature stores (skills, contacts, memory, settings, usage)

---

## 5. API Surface

### 5.1 Assistant Runtime HTTP API (port 7821)

Defined in `assistant/src/runtime/routes/` (90+ route files). Key endpoints:

| Method | Path | Handler | Purpose |
|--------|------|---------|---------|
| `POST` | `/v1/messages` | `conversation-routes.ts:905` | Send a message (returns 202) |
| `GET` | `/v1/messages` | `conversation-routes.ts:345` | Paginated message history |
| `GET` | `/v1/events` | `events-routes.ts` | SSE stream of `AssistantEvent`s |
| `GET` | `/v1/suggestions` | `conversation-routes.ts:1664` | Contextual suggestions |
| `POST` | `/v1/confirm` | `approval-routes.ts` | Respond to approval prompts |
| `POST` | `/v1/secret` | `approval-routes.ts` | Provide secret values |
| `POST` | `/v1/trust-rules` | `approval-routes.ts` | Create persistent trust rules |
| `POST` | `/v1/host-bash-result` | host proxy routes | Receive shell output from desktop |
| `POST` | `/v1/host-file-result` | host proxy routes | Receive file operation results |
| `POST` | `/v1/host-cu-result` | host proxy routes | Receive computer-use results |
| — | `/v1/conversations/*` | conversation routes | Conversation CRUD |
| — | `/v1/channels/*` | channel routes | Channel management, verification |
| — | `/v1/contacts/*` | contact routes | Contact directory |
| — | `/v1/apps/*` | app routes | App gallery |
| — | `/v1/skills/*` | skill routes | Skill management |

**Authentication**: JWT Bearer tokens (`Authorization: Bearer <jwt>`).
- Claims: `iss`, `aud` (`vellum-daemon` or `vellum-gateway`), `sub`, `scope_profile`, `exp`, `policy_epoch`, `jti`
- Scope profiles: `actor_client_v1`, `gateway_ingress_v1`, `gateway_service_v1`, `internal_v1`
- Rate limiting: 300 req/min (authenticated), 20 req/min (unauthenticated) per `runtime/middleware/rate-limiter.ts`

### 5.2 Gateway HTTP API (port 7830)

Defined in `gateway/src/http/routes/`. Public ingress for external services:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/webhooks/telegram` | Telegram bot webhook (HMAC-verified) |
| `POST` | `/deliver/telegram` | Runtime → Telegram delivery |
| `POST` | `/webhooks/twilio/voice` | Twilio voice webhook |
| `WS` | `/webhooks/twilio/relay` | Twilio ConversationRelay WebSocket |
| `POST` | `/webhooks/twilio/status` | Twilio status callbacks |
| `GET` | `/webhooks/oauth/callback` | OAuth provider redirects |
| `GET/PATCH` | `/v1/feature-flags` | Feature flag management |
| — | `/v1/channel-verification-sessions/*` | Verification session proxy |
| — | `/v1/contacts/*` | Contact management proxy |
| `GET` | `/v1/health` | Authenticated health check proxy |
| `GET` | `/healthz` | Liveness probe (always 200) |
| `GET` | `/readyz` | Readiness probe (503 during drain) |

### 5.3 Streaming Events (SSE)

`GET /v1/events` streams `AssistantEvent` types including:
- `text_delta`, `thinking_delta` — Streaming LLM output
- `message_complete` — Full message with metadata
- `tool_use`, `tool_output_chunk`, `tool_result` — Tool execution lifecycle
- `tool_use_preview_start`, `input_json_delta` — Tool parameter streaming
- `server_tool_start`, `server_tool_complete` — Server-side tool execution
- `usage` — Token accounting
- `error` — Error events

Event Hub (`runtime/assistant-event-hub.ts`): In-process pub/sub, filtered by `assistantId` and optional `conversationId`, synchronous fanout.

---

## 6. Testing

### 6.1 Frameworks

| Component | Framework | Runner |
|-----------|-----------|--------|
| TypeScript (all packages) | `bun:test` | `bun test` via `assistant/scripts/test.sh` |
| Swift (macOS, iOS, shared) | XCTest | Xcode / `swift test` |

### 6.2 Test Configuration

- **Test runner script**: `assistant/scripts/test.sh` — Runs each test file in an isolated Bun process (process isolation for `mock.module` conflicts). Supports parallel execution with configurable workers (defaults to CPU count).
- **Timeout**: 120 seconds per test (configurable via `PER_TEST_TIMEOUT`).
- **Coverage**: Enabled via `COVERAGE=true`, generates per-file lcov reports merged into `coverage/lcov.info`.
- **Affected tests**: `scripts/affected-tests.ts` determines which tests to run based on changed files (used in CI).

### 6.3 Test Distribution

**Total test files: ~955 (792 TypeScript + 163 Swift)**

| Location | Count | Focus |
|----------|-------|-------|
| `assistant/src/__tests__/` | ~620 | Integration and system-level tests |
| `assistant/src/*/` (distributed) | ~73 | Unit tests co-located with source |
| `gateway/src/__tests__/` | included | Gateway route and auth tests |
| `cli/src/__tests__/` | included | CLI command tests |
| `credential-executor/src/__tests__/` | included | CES command and grant tests |
| `clients/macos/vellum-assistantTests/` | ~155 | macOS UI and integration tests |
| `clients/shared/Tests/` | ~6 | Cross-platform shared logic |
| `clients/ios/Tests/` | ~2 | iOS-specific tests |

### 6.4 Coverage Assessment

**Well-tested areas:**
- Authentication and authorization (`assistant/src/runtime/auth/__tests__/` — 11 files)
- Memory graph operations (`assistant/src/memory/graph/` — 6 test files)
- OAuth flows (`assistant/src/cli/commands/oauth/__tests__/` — 8 files)
- Skill loading, feature flags, version hashing (10+ test files)
- Guardian approval system (multiple test files)
- Tool execution and permission handling
- Gateway webhook routing
- macOS ChatViewModel (extensive test suite in `ChatViewModelTests.swift`)

**Architectural guard tests:**
- `gateway-only-guard.test.ts` — Ensures public APIs route through gateway
- `assistant-id-boundary-guard.test.ts` — Ensures daemon uses `DAEMON_INTERNAL_ASSISTANT_ID`
- `no-direct-anthropic-sdk-imports.test.ts` — Enforces provider abstraction
- Feature flag format validation and registry completeness checks

**Areas with thin/no test coverage:**
- Daemon message handlers (`assistant/src/daemon/handlers/`) — core but untested directly
- Provider implementations (`assistant/src/providers/`) — abstraction tested but not individual providers
- Telemetry (`assistant/src/telemetry/`) — no dedicated tests found
- Work items (`assistant/src/work-items/`) — no dedicated tests found
- Notifications pipeline (`assistant/src/notifications/`) — limited tests
- iOS client (`clients/ios/Tests/` — only 2 test files)
- Chrome extension — no tests found
- Most individual skills (`skills/*/`) — no per-skill test suites

### 6.5 Skipped Tests

Only **2 intentionally skipped tests** (both with clear documentation):
- `assistant/src/__tests__/token-estimator-accuracy.benchmark.test.ts:21` — Conditional skip (requires `API_KEY` env var)
- `meta/__tests__/install.test.ts:22` — Smoke test that pulls published release (skipped in local dev)

No `test.only` or `describe.only` left in codebase.

---

## 7. Code Quality Signals

### 7.1 TODO / FIXME Comments

**Remarkably clean** — only 7 substantive TODO/FIXME comments across the entire codebase:

| File | Line | Comment |
|------|------|---------|
| `assistant/src/security/secret-ingress.ts` | 44–45 | `"TODO"` and `"FIXME"` — **these are string literals in a secret detection pattern list**, not actual TODOs |
| `assistant/src/security/secret-scanner.ts` | 123 | `"TODO"` — same, string literal in pattern list |
| `assistant/src/context/window-manager.ts` | 31 | String literal mentioning "TODOs" in context preservation prompt |
| `clients/macos/vellum-assistant/Logging/LogExporter.swift` | 303 | `// TODO: fetchPlatformLogs does not yet support time-range filtering.` |
| `clients/macos/vellum-assistantTests/ChatViewModelTests.swift` | 2052, 2172 | `// TODO: sendUserMessage is now fire-and-forget; this test needs rework` |
| `clients/shared/Features/Chat/ChatViewModel.swift` | 2039 | `// TODO: Add pagination-aware trim that doesn't regress historyCursor` |

**HACK, XXX, WORKAROUND: 0 occurrences** across the entire codebase.

### 7.2 ESLint Suppressions

**36 total `eslint-disable` comments** across 29 files:

| Rule | Count | Context |
|------|-------|---------|
| `@typescript-eslint/no-require-imports` | 13 | Dynamic requires in tests using `mock.module` (necessary for Bun test isolation) |
| `@typescript-eslint/no-explicit-any` | 8 | Schema utilities, memory stores, socket mode, event stores |
| `@typescript-eslint/no-empty-object-type` | 1 | `runtime/channel-readiness-types.ts:30` |
| `prefer-const` | 1 | `__tests__/assistant-event-hub.test.ts:262` |

All suppressions appear justified. The `no-require-imports` suppressions are a consequence of Bun's `mock.module` requiring `require()` calls.

### 7.3 TypeScript Strictness

- **`@ts-ignore`: 0 occurrences** — never used anywhere
- **`@ts-expect-error`: 7 occurrences** — all in test files, used to test runtime validation of invalid inputs
  - `assistant/src/__tests__/managed-store.test.ts:755,757,759`
  - `credential-executor/src/__tests__/command-validator.test.ts:184,194,210,608`

### 7.4 Linting Configuration

- **ESLint**: Modern flat config (`assistant/eslint.config.mjs`) with `typescript-eslint` and `eslint-plugin-simple-import-sort`. Test files have relaxed `no-explicit-any`.
- **Prettier**: Configured with exclusions for `SKILL.md` (YAML frontmatter) and prompt templates.
- **Periphery** (Swift): Dead code analysis with 137KB baseline file, configured via `.periphery.yml`.
- **Knip**: Dead code detection for TypeScript in `assistant/knip.json`, `cli/knip.json`, `gateway/knip.json`.

### 7.5 Git Hooks

`.githooks/` contains pre-commit hooks. `setup.sh` configures git to use them.

---

## 8. Contribution Surface

### 8.1 CONTRIBUTING.md

**External contributions are not currently accepted.**

From `CONTRIBUTING.md`:
> We are not currently accepting external contributions. This may change in the future.

Allowed:
- Bug reports via GitHub issues
- Feature requests via GitHub issues
- Security vulnerabilities via `security@vellum.ai` (see `SECURITY.md`)

Pull requests will be closed.

### 8.2 Issue Templates

- `bug_report.yml` — Structured bug report form
- `feature_request.yml` — Feature request form
- `config.yml` — Disables blank issues, links to Discord community (`vellum.ai/community`)

**Current open issues: 0** (empty issue tracker as of this report).

No `good first issue` or `help wanted` labels exist.

### 8.3 CODEOWNERS

Tight ownership with 5 identified DRIs (Directly Responsible Individuals):

| Owner | Areas |
|-------|-------|
| `@siddseethepalli` | Memory system, tool infrastructure |
| `@awlevin` | Skill system, system prompts, identity/personality |
| `@alex-nork` | Voice/calls, Twilio integration |
| `@vincent0426` | MCP integration |
| `@noanflaherty` | Guardian approvals, permissions, trust rules, contacts |
| `@AnitaKirkovska` | Identity/personality templates |

### 8.4 Areas Receptive to External Contribution

**Most receptive (if contributions open up):**
1. **New skills** (`skills/`) — Self-contained, well-defined interface, minimal coupling to internals. Each skill is just `SKILL.md` + optional scripts.
2. **Shared design system** (`clients/shared/DesignSystem/`) — Component library with clear patterns.
3. **Benchmarking** (`benchmarking/`) — Performance evaluation frameworks.
4. **Documentation** (`docs/`) — Internal reference is 39KB but external docs are thin.

**Tightly coupled / likely overwritten:**
- Core daemon logic (`assistant/src/daemon/`) — Rapidly evolving, complex state management
- Provider abstraction (`assistant/src/providers/`) — Requires deep integration testing
- Gateway routing (`gateway/src/`) — Security-critical, tight coupling to webhook contracts
- CES (`credential-executor/`) — Security-critical, process isolation boundary
- Native clients (`clients/macos/`, `clients/ios/`) — Xcode project, heavy AppKit dependencies

---

## 9. Gaps and Opportunities

### 9.1 Missing Tests for Important Code Paths

| Area | Gap | Impact |
|------|-----|--------|
| `assistant/src/daemon/handlers/` | No direct handler tests | Daemon message handlers are the core dispatch layer — bugs here affect all conversations |
| `assistant/src/providers/` | Individual provider implementations untested | Provider-specific edge cases (rate limits, error mapping, streaming quirks) could regress |
| `assistant/src/notifications/` | Limited test coverage | Notification routing and delivery logic |
| `assistant/src/work-items/` | No dedicated tests | Work item coordination logic |
| `assistant/src/telemetry/` | No tests | Telemetry collection could silently break |
| `clients/ios/Tests/` | Only 2 test files | iOS app has minimal test coverage vs. macOS's 155 |
| `clients/chrome-extension/` | No tests at all | Browser extension is completely untested |
| Individual skills (`skills/*/`) | No per-skill test suites | Skills have test infrastructure but no individual skill tests |
| `ChatViewModelTests.swift:2052,2172` | 2 tests marked TODO for rework | Fire-and-forget message sending broke existing test patterns |

### 9.2 Documentation Gaps

| Area | Gap |
|------|-----|
| **External user docs** | No user-facing documentation beyond README. No setup guides, tutorials, or API docs. |
| **Skill authoring guide** | `skills/AGENTS.md` exists but is agent-oriented, not human-readable contributor guide. No "How to write a skill" tutorial. |
| **API reference** | No OpenAPI spec published (though `scripts/generate-openapi.ts` exists). 90+ route files with no centralized API docs. |
| **iOS client** | `clients/ios/` has no README or architecture doc (macOS has both). |
| **Chrome extension** | `clients/chrome-extension/` — no documentation at all. |
| **Memory system** | `assistant/docs/architecture/memory.md` exists but the graph memory subsystem (`memory/graph/`) lacks dedicated docs. |
| **Provider setup** | No guide for configuring alternative LLM providers (Ollama, Gemini). |

### 9.3 Partially Implemented / Stubbed Features

| Area | Evidence |
|------|----------|
| `LogExporter.swift:303` | `fetchPlatformLogs` does not yet support time-range filtering |
| `ChatViewModel.swift:2039` | Pagination-aware trim not yet implemented (follow-up planned) |
| iOS client | Described as "early development" — limited features compared to macOS |
| Chrome extension | Present in repo but minimal code, no tests, no docs |
| Benchmarking | `assistant-benchmarking-dimensions.md` proposes evaluation framework but no automated benchmark suite for assistant quality |

### 9.4 Error Handling Gaps

| Area | Notes |
|------|-------|
| Qdrant circuit breaker | `qdrant-circuit-breaker.ts` handles unavailability but recovery behavior untested |
| Embedding backend fallback | Multiple backends supported but no documented fallback chain when primary fails |
| CES grant expiry | Temporary grants auto-expire but edge cases (expired mid-execution) unclear |
| Gateway WebSocket | Twilio relay and browser relay have reconnection logic but error states could be more robust |

### 9.5 Extensibility Points Designed for Community

1. **Skill System** — The clearest extension point. Each skill is a self-contained directory with a well-defined contract (`SKILL.md` + optional `TOOLS.json` + scripts). The `SkillToolScript` interface is 6 lines:
   ```typescript
   interface SkillToolScript {
     run(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult>;
   }
   ```
   Skills can use bash, TypeScript, or Python scripts. The catalog (`skills/catalog.json`) is a simple JSON registry.

2. **Embedding Backends** — `embedding-backend.ts` defines an abstract interface. New embedding providers (Cohere, Voyage, local models) could be added following the pattern of `embedding-openai.ts`, `embedding-gemini.ts`, `embedding-ollama.ts`.

3. **LLM Providers** — The provider abstraction in `providers/` with model intent system (`latency-optimized`, `quality-optimized`, `vision-optimized`) is designed for extensibility. New providers follow a clear pattern.

4. **Channel Adapters** — Each channel (Telegram, Slack, WhatsApp, email) is a separate adapter. New channels would need a gateway webhook handler + assistant channel adapter.

5. **Design System Components** — `clients/shared/DesignSystem/` is well-organized with tokens, core components, and a gallery. New UI components follow clear patterns.

6. **MCP Server Integration** — `assistant/src/mcp/` supports Model Context Protocol servers, allowing extension via external tool servers without modifying assistant code.

### 9.6 Contribution Feasibility Summary

Given that external PRs are currently closed, the most valuable **issue-based contributions** would be:

| Priority | Area | Type | Rationale |
|----------|------|------|-----------|
| High | New skill ideas | Feature requests | Self-contained, clear interface, largest extension surface |
| High | API documentation | Bug reports / feature requests | No published API reference despite 90+ endpoints |
| Medium | iOS parity tracking | Feature requests | iOS client is early stage vs. mature macOS |
| Medium | Bug reports with repro steps | Bug reports | Clean codebase suggests active triage |
| Medium | Provider-specific edge cases | Bug reports | Multi-provider support means many untested provider combinations |
| Low | Benchmark proposals | Feature requests | Framework proposed but not implemented |
| Low | Chrome extension improvements | Feature requests | Minimal current implementation |

If contributions open up in the future, the **skill system** is by far the most feasible entry point — each skill is isolated, has a minimal interface, and the catalog is a simple JSON file.

---

## Appendix: Key File Reference

### Entry Points
| Component | File |
|-----------|------|
| Global CLI | `meta/bin/vellum.js` |
| CLI commands | `cli/src/index.ts` |
| Assistant daemon | `assistant/src/index.ts` → `assistant/src/daemon/main.ts` |
| Gateway | `gateway/src/index.ts` |
| CES (local) | `credential-executor/src/main.ts` |
| CES (managed) | `credential-executor/src/managed-main.ts` |
| macOS app | `clients/macos/vellum-assistant/App/AppDelegate.swift` |
| iOS app | `clients/ios/App/VellumAssistantApp.swift` |

### Core Abstractions
| Abstraction | File |
|-------------|------|
| Conversation | `assistant/src/daemon/conversation.ts` |
| Agent Loop | `assistant/src/agent/loop.ts` |
| Tool Registry | `assistant/src/tools/registry.ts` |
| Tool Executor | `assistant/src/tools/executor.ts` |
| Tool Manifest | `assistant/src/tools/tool-manifest.ts` |
| Skill Load Tool | `assistant/src/tools/skills/load.ts` |
| Skill Execute Tool | `assistant/src/tools/skills/execute.ts` |
| Skill Tool Factory | `assistant/src/tools/skills/skill-tool-factory.ts` |
| Skill Script Contract | `assistant/src/tools/skills/script-contract.ts` |
| Memory Store | `assistant/src/memory/conversation-crud.ts` |
| Memory Indexer | `assistant/src/memory/indexer.ts` |
| Embedding Backend | `assistant/src/memory/embedding-backend.ts` (interface) |
| Qdrant Client | `assistant/src/memory/qdrant-client.ts` |
| HTTP Router | `assistant/src/runtime/http-router.ts` |
| HTTP Server | `assistant/src/runtime/http-server.ts` |
| Auth Middleware | `assistant/src/runtime/auth/middleware.ts` |
| Token Service | `assistant/src/runtime/auth/token-service.ts` |
| Event Hub | `assistant/src/runtime/assistant-event-hub.ts` |
| Permission Prompter | `assistant/src/permissions/prompter.ts` |
| Context Window | `assistant/src/context/window-manager.ts` |
| Provider Abstraction | `assistant/src/providers/provider-send-message.ts` |
| Message Protocol | `assistant/src/daemon/message-protocol.ts` |
| Gateway Router | `gateway/src/http/router.ts` |
| Feature Flags | `meta/feature-flags/feature-flag-registry.json` |
| Skill Catalog | `skills/catalog.json` |

### Architecture Documentation
| Document | File |
|----------|------|
| Top-level architecture | `ARCHITECTURE.md` |
| Agent/developer guide | `AGENTS.md` |
| Assistant architecture | `assistant/ARCHITECTURE.md` |
| Gateway architecture | `gateway/ARCHITECTURE.md` |
| Client architecture | `clients/ARCHITECTURE.md` |
| Memory system | `assistant/docs/architecture/memory.md` |
| Integrations | `assistant/docs/architecture/integrations.md` |
| Scheduling | `assistant/docs/architecture/scheduling.md` |
| Security | `assistant/docs/architecture/security.md` |
| Skill permissions | `assistant/docs/skills.md` |
| Error handling | `assistant/docs/error-handling.md` |
| Internal reference | `docs/internal-reference.md` |
