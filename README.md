# Vellum Assistant

[![CI Assistant](https://github.com/vellum-ai/vellum-assistant/actions/workflows/ci-main-assistant.yaml/badge.svg)](https://github.com/vellum-ai/vellum-assistant/actions/workflows/ci-main-assistant.yaml)
[![CI Gateway](https://github.com/vellum-ai/vellum-assistant/actions/workflows/ci-main-gateway.yaml/badge.svg)](https://github.com/vellum-ai/vellum-assistant/actions/workflows/ci-main-gateway.yaml)
[![CI CLI](https://github.com/vellum-ai/vellum-assistant/actions/workflows/ci-main-cli.yaml/badge.svg)](https://github.com/vellum-ai/vellum-assistant/actions/workflows/ci-main-cli.yaml)
[![CI macOS](https://github.com/vellum-ai/vellum-assistant/actions/workflows/ci-main-macos.yaml/badge.svg)](https://github.com/vellum-ai/vellum-assistant/actions/workflows/ci-main-macos.yaml)
[![CI iOS](https://github.com/vellum-ai/vellum-assistant/actions/workflows/ci-main-ios.yaml/badge.svg)](https://github.com/vellum-ai/vellum-assistant/actions/workflows/ci-main-ios.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A personal AI assistant that lives on your machine, has its own identity, and actually does things in the world.

Vellum Assistant is an open-source AI assistant platform built with TypeScript and Swift. It runs locally, owns its own credentials, and can browse the web, manage email, run code in sandboxed environments, and integrate with services like Gmail, Slack, and Telegram. Designed around four principles: it is inviting, it is yours, it is not you, and it needs to earn your trust.

## Features

- macOS menu bar app + iOS chat app
- Sandboxed code execution (native OS sandboxing via sandbox-exec/bwrap)
- Credential vault — secrets never exposed to the LLM
- Browser automation (Playwright-based)
- OAuth integrations (Gmail, Slack, Telegram)
- Dynamic skill authoring — create new skills at runtime
- Multi-instance support — run multiple assistants side by side
- Multi-provider LLM support (Anthropic, OpenAI, Google, Ollama)
- Real-time event streaming API (SSE)

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) v1.3.9+
- [Docker](https://docs.docker.com/get-docker/) (for sandboxed execution)
- An Anthropic API key (or other supported LLM provider)

### Install and run

```bash
# Install the CLI
npm install -g @vellumai/cli

# Create an assistant
vellum hatch

# Start the assistant
vellum wake

# Check status
vellum ps
```

Or download the [macOS app](https://github.com/vellum-ai/velly/releases/latest) for a native menu bar experience.

## Architecture

The platform has three main domains:

- **Assistant runtime** (`assistant/`): Bun + TypeScript assistant runtime that owns conversation history, attachment storage, and channel delivery state in a local SQLite database. Exposes a Unix domain socket (macOS) and optional TCP listener (iOS) for native clients, plus an HTTP API consumed by the gateway.
- **Native clients** (`clients/`): Swift Package with macOS and iOS apps sharing ~45-50% of code via `VellumAssistantShared`. The macOS app is a menu bar assistant with computer-use (accessibility + CGEvent). The iOS app is a chat client supporting standalone mode (direct Anthropic API) and connected-to-Mac mode (TCP proxy through the assistant).
- **Gateway** (`gateway/`): Standalone Bun + TypeScript service that serves as the public ingress boundary for all external webhooks and callbacks. Owns Telegram integration end-to-end, routes Twilio voice webhooks, handles OAuth callbacks, and optionally acts as an authenticated reverse proxy for the assistant runtime API.

### Repository Structure

```
/
├── assistant/         # Bun-based assistant runtime (runtime, CLI, HTTP API)
├── clients/           # Native clients (macOS menu bar app + iOS chat app)
├── gateway/           # Telegram gateway service
├── benchmarking/      # Load testing scripts (gateway webhook/proxy benchmarks)
├── scripts/           # Utility scripts (publishing, tunneling)
├── .claude/           # Claude Code slash commands and workflow tools
└── .github/           # GitHub Actions workflows
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for full details.

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — System architecture
- [`docs/internal-reference.md`](docs/internal-reference.md) — Detailed reference (security, permissions, API, features, development workflow)
- [`assistant/docs/architecture/security.md`](assistant/docs/architecture/security.md) — Security architecture deep dive
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — Contributing guidelines
- [`SECURITY.md`](SECURITY.md) — Security vulnerability reporting

## License

MIT — see [LICENSE](LICENSE) for details.
