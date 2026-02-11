# Vellum Assistant

AI-powered assistant platform by Vellum.

## Architecture

The platform has two main components:

- **Assistant runtime** (`assistant/`): Bun + TypeScript daemon that owns conversation history, attachment storage, and channel delivery state in a local SQLite database. Exposes an HTTP API consumed by the web app.
- **Web app** (`web/`): Next.js frontend and API layer. Stores assistant metadata, auth, and channel config in Postgres. All chat operations proxy through the assistant runtime via a unified `RuntimeClient`.

## Repository Structure

```
/
├── web/               # Next.js web application
├── assistant/         # Bun-based assistant runtime
├── platform/          # Terraform infrastructure
├── vel/               # Development toolkit CLI
└── .github/           # GitHub Actions workflows
```

## Development Toolkit

The `vel` CLI provides common development operations. After running `./setup.sh`, you can use `vel` directly:

```bash
./setup.sh          # Sets up vel CLI and creates symlink

vel up              # Start development environment
vel down            # Stop development environment
vel setup           # Run initial setup
vel ps              # List running services
vel help            # Show help
```

The setup script creates a symlink at `~/.local/bin/vel` for easy access from anywhere.

See [vel/README.md](./vel/README.md) for more details.

## Git Hooks

This repository includes git hooks to help maintain code quality and security. The hooks are automatically installed when you run `./setup.sh`.

To manually install or update hooks:
```bash
./.githooks/install.sh
```

See [.githooks/README.md](./.githooks/README.md) for more details about available hooks.

## Web Application

The web app lives in `/web`. See [web/README.md](./web/README.md) for setup instructions.

```bash
cd web
npm install
npm run dev
```

## Assistant Runtime

The assistant runtime lives in `/assistant`. See [assistant/README.md](./assistant/README.md) for details.

```bash
cd assistant
bun install
bun run src/index.ts daemon start
```

## License

Proprietary - Vellum AI
