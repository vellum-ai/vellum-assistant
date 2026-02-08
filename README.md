# Vellum Assistant

AI-powered assistant platform by Vellum.

## Repository Structure

```
/
├── web/               # Next.js web application
├── assistant/         # Bun-based assistant service
├── platform/          # Terraform infrastructure
├── vel/               # Development toolkit CLI
├── editor-templates/  # Agent editor templates
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

## Web Application

The web app lives in `/web`. See [web/README.md](./web/README.md) for setup instructions.

```bash
cd web
npm install
npm run dev
```

## License

Proprietary - Vellum AI
