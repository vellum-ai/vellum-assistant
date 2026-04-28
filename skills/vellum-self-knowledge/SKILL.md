---
name: vellum-self-knowledge
description: Answer questions about Vellum, the assistant's architecture, capabilities, and current configuration by routing to live sources of truth
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🪞"
  vellum:
    display-name: "Vellum Self-Knowledge"
    activation-hints:
      - "When the user asks what model the assistant is running on"
      - "When the user asks about Vellum, how the assistant works, or its architecture"
      - "When the user asks about the assistant's current configuration or settings"
      - "When the user asks what the assistant can do or what skills/tools are available"
    avoid-when:
      - "When the user wants to change configuration (use in-chat config instead)"
---

## Critical Rule

**Never answer from memory or general knowledge about Vellum.** Always go to a source of truth.
This skill contains zero static information — only pointers to where the truth lives.

## Sources of Truth

### 1. The `assistant` CLI — Live Runtime State

The CLI is the single source of truth for anything about the running assistant's current state.

| Question type | Command |
|---|---|
| Current model, provider, config | `assistant config get llm` |
| Full config | `assistant config list` |
| Config schema (what's configurable) | `assistant config schema [path]` |
| Available/installed skills | `assistant skills list --json` |
| Platform connection | `assistant platform status --json` |
| Auth/identity | `assistant auth info --json` |
| Connected OAuth providers | `assistant oauth status <provider>` |
| Connected clients | `assistant clients list --json` |
| Trust rules | `assistant trust list` |
| Stored credentials | `assistant credentials list` |
| API keys | `assistant keys list` |
| MCP servers | `assistant mcp list` |
| Autonomy tiers | `assistant autonomy get` |
| Watchers | `assistant watchers list` |
| Token usage/costs | `assistant usage totals` / `assistant usage breakdown --group-by provider` |
| Version | `assistant --version` |

Run `assistant --help` or `assistant <command> --help` to discover more.

### 2. Vellum Docs Site — Conceptual Knowledge

For "what is", "how does", and "why" questions, fetch the relevant page from the docs site.
Base URL: `https://www.vellum.ai/docs`

| Topic | Path |
|---|---|
| What is Vellum | `/getting-started/what-is-vellum` |
| Installation | `/getting-started/installation` |
| Quick start | `/getting-started/quick-start` |
| Your first skill | `/getting-started/your-first-skill` |
| How it all fits together | `/key-concepts/how-it-all-fits-together` |
| The workspace | `/key-concepts/the-workspace` |
| Skills & tools | `/key-concepts/skills-and-tools` |
| Memory & context | `/key-concepts/memory-and-context` |
| Channels | `/key-concepts/channels` |
| Identity | `/key-concepts/identity` |
| Scheduling | `/key-concepts/scheduling` |
| Glossary | `/key-concepts/glossary` |
| Privacy & data | `/trust-security/privacy-and-data` |
| The permissions model | `/trust-security/the-permissions-model` |
| Security best practices | `/trust-security/security-best-practices` |
| Architecture | `/developer-guide/architecture` |
| Security (developer) | `/developer-guide/security` |
| Features & capabilities | `/developer-guide/features` |
| API & communication | `/developer-guide/api` |
| Development workflow | `/developer-guide/development-workflow` |
| Contributing | `/developer-guide/contributing` |
| Local hosting | `/hosting-options/local-hosting` |
| Advanced hosting | `/hosting-options/advanced-options` |
| Environments | `/environments` |
| Pricing | `/pricing` |
| Roadmap | `/roadmap` |
| FAQ | `/help/faq` |
| Common issues | `/help/common-issues` |
| Getting help | `/help/getting-help` |
| Skills reference index | `/skills-reference` |
| Specific skill reference | `/skills-reference/<skill-name>` |

Use `web_fetch` to pull the page content. If a URL 404s, try fetching the docs homepage and navigating from the sidebar.

### 3. Source Code — Deep Implementation Details

For questions the docs and CLI can't answer (internal architecture, how a specific feature is implemented, source-level details):

1. Get the current version: `assistant --version`
2. The open source repo is at `https://github.com/vellum-ai/vellum-assistant`
3. The release for version X is at `https://github.com/vellum-ai/vellum-assistant/releases/tag/vX.Y.Z`
4. Check out the matching tag locally: `cd /workspace/vellum-assistant && git fetch --tags && git checkout v<version>`
5. Key source locations:
   - `assistant/` — Runtime (conversation loop, tool dispatch, memory, scheduling)
   - `gateway/` — Ingress boundary (webhooks, Telegram, Twilio, reverse proxy)
   - `clients/` — Native macOS client
   - `skills/` — Bundled skill definitions
   - `ARCHITECTURE.md` — Cross-system index
   - `assistant/ARCHITECTURE.md` — Runtime internals
   - `gateway/ARCHITECTURE.md` — Gateway internals
   - `assistant/docs/architecture/` — Detailed architecture docs (security, memory, etc.)
6. Read the relevant source files to answer the question.

### Resolution Order

1. **CLI first** — if the question is about current state, config, or capabilities, the CLI has it.
2. **Docs second** — if the question is conceptual ("what is X", "how does Y work"), fetch the docs page.
3. **Source code last** — only for deep implementation questions that the docs don't cover.
