# Contributing

Thank you for your interest in Vellum Assistant! We welcome contributions of all kinds — bug fixes, new features, documentation improvements, and more.

## Before you start

- **Bug reports and feature requests**: [Open an issue](https://github.com/vellum-ai/vellum-assistant/issues). Use the provided templates.
- **Security vulnerabilities**: Report these privately. See [SECURITY.md](SECURITY.md).
- **Questions and discussion**: Join us on the #contributors channel on [Discord](https://discord.com/channels/1471183263174234245/1503398277092081875).

## Development setup

### Getting started

```bash
git clone https://github.com/vellum-ai/vellum-assistant.git
cd vellum-assistant
./setup.sh    # installs Bun (if needed), installs deps, links packages, registers the global vellum CLI
```

Verify your setup:

```bash
vellum --version
```

### Running the assistant locally

**CLI only:**

```bash
vellum hatch   # first-time setup (only needed once)
vellum wake    # start an existing assistant
vellum client  # interact with your assistant through the terminal
vellum sleep   # stop but do not remove an existing assistant
```

### Running tests

```bash
# Assistant
cd assistant && bun run test

# CLI
cd cli && bun run test

# Credential Executor
cd credential-executor && bun run test

# Gateway
cd gateway && bun run test
```

### Linting and type checking

```bash
# From any package directory (assistant/, cli/, gateway/)
bun run lint
bun run typecheck
```

### Using AI coding assistants

If you use Claude Code, see [.claude/README.md](.claude/README.md) for setup (shared slash commands, fast mode, typical workflow).

## Project structure

| Directory | What it is |
|---|---|
| `assistant/` | Core assistant runtime — memory, tools, skills, scheduling, integrations |
| `gateway/` | Public ingress — webhooks, API routes, OAuth callbacks |
| `cli/` | The `vellum` CLI |
| `apps/` | End-user app surfaces (web, iOS, macOS/Electron, Chrome extension) |
| `credential-executor/` | Isolated credential execution service |
| `packages/` | Shared internal packages |
| `skills/` | Skill definitions |

For deeper architectural context, see [ARCHITECTURE.md](ARCHITECTURE.md) and the domain-specific docs linked from it.

## Personalizing your assistant vs. changing the core

Before opening a PR, ask: **does this belong in everyone's assistant, or just mine?**

A lot of "new feature" ideas are really *personal customization*: for example, a morning briefing, a recurring cleanup, a custom routine, or stitching existing capabilities together. These belong in **your assistant's own workspace**, not in the shared runtime. You don't need to fork the repo or wait for a review to get them, just ask your assistant to build it for you!

### When a core change *is* the right call

Adding or changing a **core tool** (anything under `assistant/src/tools/` registered in the tool manifest) ships to **every** user and is loaded into the agent's context on every turn — always-loaded tools share a tight budget, so each one has to earn its place. Open a PR for core changes only when the change is:

- a **new primitive** that can't be expressed as a skill composed from existing tools, or
- a bug fix, performance, security, or developer-experience improvement to existing behavior, or
- there is pre-existing discussion on GitHub or Discord with the core team on why it will be broadly useful to most users.

If you can build it as a skill in your own workspace, do that first. If you think a personal skill would genuinely benefit others, contribute it to [`skills/`](skills/) (see [`skills/AGENTS.md`](skills/AGENTS.md)) rather than adding a core tool. When in doubt, [open an issue](https://github.com/vellum-ai/vellum-assistant/issues) or ask on [Discord](https://vellum.ai/community) before writing new core capabilities.

## Submitting a pull request

1. Fork the repo and create a branch from `main`.
2. Make your changes. Write tests where applicable.
3. Make sure CI passes locally: `bun run lint && bun run typecheck && bun run test` in the relevant package(s).
4. Open a PR against `main`. Fill out the PR template.
5. A maintainer will review your PR. We aim to respond within a few business days.

### PR guidelines

- **Keep PRs focused.** One logical change per PR. Smaller PRs get reviewed faster.
- **PR titles** follow conventional commits format: `type(scope): description` (e.g., `feat(slack): add user token support`, `fix(cli): handle missing config`).
- **We assume AI was used.** That's fine — just include the prompt or plan you used in the PR description.
- **Don't submit PRs against `release/*` branches.** These are for release management only.

### What makes a good contribution

- Fixes a bug you encountered while using the assistant
- Improves documentation or developer experience
- Adds test coverage for untested paths
- Implements a feature you've discussed in an issue or on Discord
- Adds a broadly useful primitive or a reusable skill to [`skills/`](skills/)

### Large Initiatives

If there's a larger body of work that you'd like to champion, we'd love to help you see it through! We do request to hop on a call to understand the full context and be able to advise most effectively. Reach out to a member of the core team to coordinate scheduling.

## Code of Conduct

All participants are expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
