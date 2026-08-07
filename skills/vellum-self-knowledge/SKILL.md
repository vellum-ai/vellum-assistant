---
name: vellum-self-knowledge
description: Answer questions about Vellum's architecture, configuration, and hosting from live sources of truth
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🪞"
  vellum:
    category: "system"
    display-name: "Vellum Self-Knowledge"
    activation-hints:
      - "what model the assistant is running on"
      - "how Vellum works or its architecture"
      - "its current configuration or settings"
      - "what it can do, or what skills/tools are available"
      - "whether a service is connected, and in which sense"
      - "how to self-host a Vellum assistant"
      - "how to configure your own model API key"
    avoid-when:
      - "changing configuration (use in-chat config instead)"
---

## Critical Rule

**Never answer from memory or general knowledge about Vellum.** Always go to a source of truth.
This skill contains zero static information — only pointers to where the truth lives.

## Sources of Truth

### 1. The `assistant` CLI — Live Runtime State

The CLI is the single source of truth for anything about the running assistant's current state.

| Question type                             | Command                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| Current model, provider, config           | `assistant config get llm`                                                 |
| Full config                               | `assistant config list`                                                    |
| Config schema (what's configurable)       | `assistant config schema [path]`                                           |
| Available/installed skills                | `assistant skills list --json`                                             |
| Platform connection                       | `assistant platform status --json`                                         |
| Auth/identity                             | `assistant auth info --json`                                               |
| Which providers exist, and in which sense | `assistant oauth providers list --json`                                    |
| Whether one is actually connected         | `assistant oauth status <provider>`                                        |
| Channel delivery health                   | `assistant channels list`                                                  |
| Connected clients                         | `assistant clients list --json`                                            |
| Trust rules                               | `assistant trust list`                                                     |
| Stored credentials                        | `assistant credentials list`                                               |
| API keys                                  | `assistant keys list`                                                      |
| MCP servers                               | `assistant mcp list`                                                       |
| Watchers                                  | `assistant watchers list`                                                  |
| Token usage/costs                         | `assistant usage totals` / `assistant usage breakdown --group-by provider` |
| Version                                   | `assistant --version`                                                      |

Run `assistant --help` or `assistant <command> --help` to discover more.

"Is X connected?" has two answers and a service can have either, both, or
neither. It takes both commands: the providers list is a catalog and says
nothing about whether anything is connected, so use it to find which provider
keys belong to X, then check each with `oauth status`.

Each provider in that list carries its sense: `actsAs` in the CLI's JSON,
`acts_as` over HTTP. `user` means the assistant can act as the person who
authorized it, `assistant` means a bot people reach the assistant through.
Report the sense found rather than a bare yes.

Do not infer the sense from the provider key. `slack` and `discord` name the
user integration while their bots are `slack_channel` and `discord_channel`,
yet `telegram` is itself the bot. Some services offer both from one authorize
URL, so having done one is not evidence of the other, and people often cannot
recall which they did.

`channels list` reports delivery health for channels that have a readiness
probe, which is not all of them. It answers whether a channel is working, not
whether something is connected.

### 2. Vellum Docs Site — Conceptual Knowledge

For "what is", "how does", and "why" questions, fetch the relevant page from the docs site.
Base URL: `https://www.vellum.ai/docs`

| Topic                    | Path                                      |
| ------------------------ | ----------------------------------------- |
| What is Vellum           | `/getting-started/what-is-vellum`         |
| Installation             | `/getting-started/installation`           |
| Quick start              | `/getting-started/quick-start`            |
| Your first skill         | `/getting-started/your-first-skill`       |
| How it all fits together | `/key-concepts/how-it-all-fits-together`  |
| The workspace            | `/key-concepts/the-workspace`             |
| Skills & tools           | `/key-concepts/skills-and-tools`          |
| Memory & context         | `/key-concepts/memory-and-context`        |
| Channels                 | `/key-concepts/channels`                  |
| Identity                 | `/key-concepts/identity`                  |
| Scheduling               | `/key-concepts/scheduling`                |
| Glossary                 | `/key-concepts/glossary`                  |
| Privacy & data           | `/trust-security/privacy-and-data`        |
| The permissions model    | `/trust-security/the-permissions-model`   |
| Security best practices  | `/trust-security/security-best-practices` |
| Architecture             | `/developer-guide/architecture`           |
| Security (developer)     | `/developer-guide/security`               |
| Features & capabilities  | `/developer-guide/features`               |
| API & communication      | `/developer-guide/api`                    |
| Development workflow     | `/developer-guide/development-workflow`   |
| Contributing             | `/developer-guide/contributing`           |
| Local hosting            | `/hosting-options/local-hosting`          |
| Advanced hosting         | `/hosting-options/advanced-options`       |
| Environments             | `/environments`                           |
| Pricing                  | `/pricing`                                |
| Roadmap                  | `/roadmap`                                |
| FAQ                      | `/help/faq`                               |
| Common issues            | `/help/common-issues`                     |
| Getting help             | `/help/getting-help`                      |
| Skills reference index   | `/skills-reference`                       |
| Specific skill reference | `/skills-reference/<skill-name>`          |

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
