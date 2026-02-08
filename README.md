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

The `vel` CLI provides common development operations:

```bash
cd vel && npm install && npm run build
npm run vel up      # Start development environment
npm run vel down    # Stop development environment
npm run vel setup   # Run initial setup
npm run vel ps      # List running services
```

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
