# Vellum Assistant

AI-powered assistant platform by Vellum.

## Quick Start

Run the setup script from the project root:

```bash
./setup.sh
```

This will install all dependencies. Then follow the instructions in [web/README.md](./web/README.md) to configure your environment and start the development server.

## Repository Structure

```
/
├── web/               # Next.js web application
├── platform/          # Infrastructure (Terraform, Kubernetes)
├── editor-templates/  # Agent editor templates
└── .github/           # GitHub Actions workflows
```

## Web Application

The web app lives in `/web`. See [web/README.md](./web/README.md) for detailed setup instructions.

```bash
cd web
npm run dev
```

## License

Proprietary - Vellum AI
