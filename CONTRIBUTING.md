# Contributing

Thank you for your interest in Vellum Assistant! We welcome contributions of all kinds — bug fixes, new features, documentation improvements, and more.

## Before you start

- **Bug reports and feature requests**: [Open an issue](https://github.com/vellum-ai/vellum-assistant/issues). Use the provided templates.
- **Security vulnerabilities**: Report these privately. See [SECURITY.md](SECURITY.md).
- **Questions and discussion**: Join us on [Discord](https://vellum.ai/community).

## Development setup

### Prerequisites

- [Bun](https://bun.sh) (v1.x)
- [Docker](https://docs.docker.com/get-docker/) — required for the sandbox runtime
- macOS with [Homebrew](https://brew.sh) — needed for native client development (xcodegen is installed automatically)

### Getting started

```bash
git clone https://github.com/vellum-ai/vellum-assistant.git
cd vellum-assistant
./setup.sh    # installs deps, links packages, registers the global vellum CLI
```

Copy the environment template:

```bash
cp .env.example .env
```

Verify your setup:

```bash
vellum --version
```

### Running the assistant locally

**macOS app (recommended):**

```bash
./clients/macos/build.sh run   # build + launch + watch for changes (auto-rebuild)
```

**CLI only:**

```bash
vellum hatch   # first-time setup (only needed once)
vellum wake    # start the assistant + gateway
vellum client  # interact through the terminal
vellum sleep   # stop services
```

### Running tests

```bash
# Assistant
cd assistant && bun run test

# CLI
cd cli && bun run test

# Gateway
cd gateway && bun run test
```

### Linting and type checking

```bash
# From any package directory (assistant/, cli/, gateway/)
bun run lint
bun run typecheck
```

## Project structure

| Directory | What it is |
|---|---|
| `assistant/` | Core assistant runtime — memory, tools, skills, scheduling, integrations |
| `gateway/` | Public ingress — webhooks, API routes, OAuth callbacks |
| `cli/` | The `vellum` CLI |
| `clients/` | Native clients (macOS, iOS) |
| `credential-executor/` | Isolated credential execution service |
| `packages/` | Shared internal packages |
| `skills/` | Skill definitions |

For deeper architectural context, see [ARCHITECTURE.md](ARCHITECTURE.md) and the domain-specific docs linked from it.

## Submitting a pull request

1. Fork the repo and create a branch from `main`.
2. Make your changes. Write tests where applicable.
3. Make sure CI passes locally: `bun run lint && bun run typecheck && bun run test` in the relevant package(s).
4. Open a PR against `main`. Fill out the PR template — especially the **Rationale**, **Test plan**, and **Prompt/plan** sections.
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

## Code of Conduct

All participants are expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
