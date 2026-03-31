<p align="center">
  <img src="assets/banner.png" alt="Vellum Assistant" width="100%">
</p>

<p align="center">
  <a href="https://vellum.ai/docs"><img src="https://img.shields.io/badge/Docs-vellum.ai%2Fdocs-FFD700?style=for-the-badge" alt="Documentation"></a>
  <a href="https://vellum.ai/community"><img src="https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://github.com/vellum-ai/vellum-assistant/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License: MIT"></a>
  <a href="https://vellum.ai"><img src="https://img.shields.io/badge/Built%20by-Vellum-blueviolet?style=for-the-badge" alt="Built by Vellum"></a>
</p>

<p align="center"><b>An AI assistant that belongs to you, and learns how you work.</b></p>

<p align="center">Learns your preferences and adapts over time, builds memory that reinforces what matters and forgets what doesn't, and reaches out proactively when something needs your attention.</p>

<p align="center">Your credentials are isolated in a dedicated process and never reach the model, trust is earned not assumed, and every tool runs in a sandbox. Talk to it from the native macOS app (locally or via a managed server), Telegram, or Slack, with shared memory and identity across every surface.</p>

---

### Personality and intelligence

| Area | Summary |
|------|---------|
| **Brain (Memory engine)** | **Remembers what matters and forgets what doesn't.** Hybrid retrieval (dense + sparse with RRF) ranks results semantically and lexically. Each memory type has its own staleness window (e.g. identity facts last six months, events last three days). |
| **Backpack (Persistent memory)** | **Carries everything the assistant keeps over time.** Structured memory items like identity, preferences, projects, events are extracted by the LLM with source attribution and deduplication. Per-user and per-channel persona files, trusted contacts, and scoped memory isolation for private conversations. Embedding runs locally by default. |
| **Self (Identity layer)** | **Defines who the assistant is, not just what it says.** Behavior lives in SOUL.md, and during onboarding the assistant observes how you communicate and writes its own personality files. A journal captures retrospective context per user. NOW.md acts as an ephemeral scratchpad for current focus and active threads. |
| **Pulse (Proactivity engine)** | **Reaches out when something matters, without being asked.** Every hour it checks in with itself; re-reads its own notes, notices what's unfinished or due soon, and reaches out if something matters. Notifications are routed to the right channel and won't interrupt you if you're already talking. |

### Infra and control

| Area | Summary |
|------|---------|
| **Gatekeeper (Trust engine)** | **Decides who can do what, and defaults to no.** Fail-closed trust system that resolves actor identity once (guardian, trusted, or unknown) and enforces it everywhere. Untrusted actors cannot read or write memory, trigger tools, or escalate. Your credentials live in a separate process and never reach the model. |
| **Skills** | Manifest-driven plugins (SKILL.md + TOOLS.json) that inject tools and prompt sections at runtime. Skills can be bundled, installed from a catalog, or created within the workspace. |
| **Channels** | Interact with your assistant on the MacOS app, Telegram, and Slack, with shared memory across all of them. (More channels coming soon) |
| **Multi-provider support** | Supports Anthropic Claude, OpenAI, Google Gemini, and Ollama for local models. Embeddings follow the same pattern; local ONNX by default, with automatic fallback through cloud providers. Swap models without changing anything else. |

---

## Getting started

### Desktop App (Recommended)

The [Desktop App](./clients/macos/README.md) comes with the Vellum CLI bundled in, so you won't need to pre-install the CLI.

1. Download the latest release
2. On install, choose your mode:
   - **Local mode:** Run the assistant on the same machine as the Desktop App.
   - **Managed mode:** Sign in via the Vellum platform and connecting to a hosted assistant; no local runtime required.

The app installs dependencies, starts the runtime, and handles updates automatically.

### CLI

_Note: The CLI is functional but not our primary focus. It's available for advanced users, contributors, and non-macOS environments, but the desktop app is where we invest most of our effort and testing. Expect rough edges._

**Install**

```bash
bun install -g vellum
vellum hatch
```

**Install from source**

```bash
git clone https://github.com/vellum-ai/vellum-assistant.git
cd vellum-assistant
./setup.sh
vellum hatch
```

**Common commands**

```bash
vellum hatch       # first-time assistant setup
vellum retire      # shut down an assistant instance and clean up its data
vellum ps          # view running assistants
vellum wake        # start services (assistant + gateway + credential-executor)
vellum sleep       # stop services, keeping the assistant's data.
vellum upgrade     # upgrade to the latest version
vellum client      # connect to a running assistant and interact with it through the terminal
```

All commands reference a "default" assistant without specifying an argument. If you are tracking multiple assistants, pass in the assistant id as the second argument.

---

## Documentation

| Section | What's Covered |
|---------|---------------|
| [Architecture](https://vellum.ai/docs/developer-guide/architecture) | Platform domains, repo structure, runtime · clients · gateway |
| [Security & Permissions](https://vellum.ai/docs/developer-guide/security) | Sandbox, credentials, trust rules, permission modes |
| [Features & Capabilities](https://vellum.ai/docs/developer-guide/features) | Integrations, dynamic skills, browser, attachments, media embeds |
| [API & Communication](https://vellum.ai/docs/developer-guide/api) | SSE event stream, event payloads, remote access |
| [Development Workflow](https://vellum.ai/docs/developer-guide/development-workflow) | Claude Code commands, parallel PRs, review loops, release pipeline |

📖 **[Full documentation →](https://vellum.ai/docs)**

---

## Contributing

We are not currently accepting external contributions. See the [Contributing](https://github.com/vellum-ai/vellum-assistant?tab=contributing-ov-file) tab for updates.

---

## Community

- 💬 [Discord](https://vellum.ai/community)
- 🐛 [Issues](https://github.com/vellum-ai/vellum-assistant/issues)

---

## License

MIT — see [License](https://github.com/vellum-ai/vellum-assistant?tab=MIT-1-ov-file).

Vellum Assistant is open-source software built by [Vellum AI](https://vellum.ai), a for-profit company. We also offer a managed product — the [Vellum Platform](https://vellum.ai/platform) — which sustains the business. This project is free to use, modify, and contribute to under the MIT license, and we're committed to keeping it that way.

---

<p align="center">Built with 💚 by <a href="https://vellum.ai">Vellum</a></p>
