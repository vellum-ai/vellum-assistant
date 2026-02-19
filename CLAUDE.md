# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Structure

Bun + TypeScript monorepo with multiple packages:

- `assistant/` — Main backend service (Bun + TypeScript)
- `gateway/` — Telegram webhook gateway (Bun + TypeScript)
- `clients/macos/` — Native macOS desktop app (Swift/SwiftUI, see `clients/macos/CLAUDE.md`)
- `scripts/` — Utility scripts
- `.claude/` — Claude Code slash commands and helper scripts (see `.claude/README.md`)

## Conventions

- **Bun PATH**: Run `export PATH="$HOME/.bun/bin:$PATH"` before any bun/bunx commands.
- **Imports**: All imports use `.js` extensions (NodeNext module resolution).
- **Package manager**: Use `bun install` for dependencies, `bun test` for tests, `bunx tsc --noEmit` for type-checking.
- **Install dependencies**: `cd assistant && bun install` (each package has its own `bun.lock`).

## Development

```bash
# Install dependencies
cd assistant && bun install

# Type-check
cd assistant && bunx tsc --noEmit

# Run tests
cd assistant && bun test

# Lint
cd assistant && bun run lint
```
