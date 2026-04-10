<p align="center">
  <img src="assets/banner.png" alt="Vellum Assistant" width="100%">
</p>

<p align="center">
  <a href="https://vellum.ai/docs"><img src="https://img.shields.io/badge/Docs-vellum.ai%2Fdocs-FFD700?style=for-the-badge" alt="Documentation"></a>
  <a href="https://vellum.ai/community"><img src="https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://github.com/vellum-ai/vellum-assistant/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License: MIT"></a>
  <a href="https://vellum.ai"><img src="https://img.shields.io/badge/Built%20by-Vellum-blueviolet?style=for-the-badge" alt="Built by Vellum"></a>
</p>

<p align="center"><b>A personal AI assistant that evolves with you.</b></p>

<p align="center">It learns your preferences, remembers what matters, and gets better the more you use it. When something needs your attention, it tells you.</p>

<p align="center"><b>It's yours to shape:</b> Give it a name, a personality, and new skills, with as much autonomy as you're comfortable giving. Talk to it from the macOS app, Telegram, or Slack, with the same memory and identity everywhere.</p>

<p align="center"><b>It earns your trust:</b> Credentials are protected from the model, every tool runs in a sandbox, and access to your apps, files, and data is earned, not assumed.</p>

---

### Personality and intelligence

| Area | Summary |
|------|---------|
| **Memory engine** | **Remembers what matters and forgets what doesn't.** Hybrid retrieval (dense + sparse with RRF) ranks results semantically and lexically. Each memory type has its own staleness window (e.g. identity facts last six months, events last three days). |
| **Persistent memory** | **Long-term storage for what the assistant learns about you.** Structured memory items — identity, preferences, projects, events — are extracted by the LLM with source attribution and deduplication. Per-user and per-channel persona files, trusted contacts, and scoped memory isolation for private conversations. Embeddings run locally by default. |
| **Identity layer** | **Defines who the assistant is, not just what it says.** Behavior lives in SOUL.md, and during onboarding, the assistant observes how you communicate and writes its own personality files. A per-user journal captures the assistant's reflections on past interactions. NOW.md acts as an ephemeral scratchpad for current focus and active threads. |
| **Proactivity engine** | **Reaches out when something matters, without being asked.** Every hour it checks in with itself: re-reads its own notes, notices what's unfinished or due soon, and sends a message if needed. Notifications are routed to the right channel and won't interrupt you if you're already talking. |

### Infra and security

| Area | Summary |
|------|---------|
| **Trust engine** | **Decides who can do what, and defaults to no.** Fail-closed trust system that resolves actor identity once (guardian, trusted, or unknown) and enforces it everywhere. Untrusted actors cannot read or write memory, trigger tools, or escalate. Your credentials live in a separate process and never reach the model. |
| **Skills** | **Add new capabilities through sandboxed plugins.** Manifest-driven plugins (SKILL.md + TOOLS.json) that inject tools and prompt sections at runtime. Skills can be bundled, installed from a catalog, or added from the workspace. |
| **Channels** | **One assistant, everywhere you need it.** Use it from the macOS app, Telegram, or Slack, with shared memory across all of them. More channels coming soon. |
| **Multi-provider support** | **Swap models without changing anything else.** Supports Anthropic Claude, OpenAI, Google Gemini, and Ollama for local models. Embeddings follow the same pattern: local ONNX by default, with automatic fallback to cloud providers. |

---

### Quick Demo

https://github.com/user-attachments/assets/009bd0ae-95ac-4cf3-81bc-d54cd8631583

---

## Getting started

### Desktop App (Recommended)

The macOS Desktop App comes with the Vellum CLI bundled in, no extra install needed.

1. Download the [latest release](https://github.com/vellum-ai/vellum-assistant/releases)
2. During setup, choose your mode:
    - **Local mode:** Everything runs on your machine.
    - **Managed mode:** Sign in via the Vellum Cloud and connect to a hosted assistant; no local runtime required.

The app installs dependencies, starts the runtime, and handles updates automatically.

### CLI

*Note: The CLI works but the desktop app is our primary focus. It's available for advanced users, contributors, and non-macOS environments. Expect rough edges.*

**Install**

```bash
bun install -g vellum  # Install the vellum package
vellum hatch           # first-time assistant setup
```

**Install from source**

```bash
git clone https://github.com/vellum-ai/vellum-assistant.git
cd vellum-assistant
./setup.sh    # installs deps, links packages, registers the global vellum CLI
vellum hatch  # first-time assistant setup
```

**Common commands**

```bash
vellum wake        # start services
vellum sleep       # stop services, keep data
vellum client      # interact through the terminal
vellum ps          # view running assistants
vellum upgrade     # upgrade to latest version
```

All commands target the default assistant. If you have multiple assistants, pass the assistant ID as the second argument.

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

We're not accepting external contributions yet. See the [Contributing](https://github.com/vellum-ai/vellum-assistant?tab=contributing-ov-file) tab for updates.

---

## Community

- 💬 [Discord](https://vellum.ai/community)
- 🐛 [Issues](https://github.com/vellum-ai/vellum-assistant/issues)

---

## License

MIT — see [License](https://github.com/vellum-ai/vellum-assistant?tab=MIT-1-ov-file). Integration logos are sourced from [Simple Icons](https://github.com/simple-icons/simple-icons) and licensed under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/).

Vellum Assistant is open-source software built by [Vellum AI](https://vellum.ai), a for-profit company. We also offer a managed product — the [Vellum Platform](https://vellum.ai/platform) — which sustains the business. This project is free to use and modify under the MIT license, and we're committed to keeping it that way.

---

<p align="center">Built with 💚 by <a href="https://vellum.ai">Vellum</a></p>
