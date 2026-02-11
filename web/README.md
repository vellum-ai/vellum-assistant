# Vellum Assistant - Web App

Next.js web application for Vellum Assistant.

## Prerequisites

- Node.js 20+
- npm or bun
- PostgreSQL database

## Development

See the [root README](../README.md) for local development setup instructions.

## Connection Mode

The web API supports two deployment-level assistant connection modes:

- `ASSISTANT_CONNECTION_MODE=cloud` (default): use cloud compute instance routes.
- `ASSISTANT_CONNECTION_MODE=local`: use a running local daemon over a Unix socket.

Optional socket override for local mode:

- `LOCAL_DAEMON_SOCKET_PATH` (default: `~/.vellum/vellum.sock`)

### Local Daemon Notes

- Local mode is strict: there is no fallback to demo or cloud behavior if the daemon is unavailable.
- Current local-mode scope is chat + health only.
- File system and logs APIs return unsupported in local mode.
- Daemon lifecycle is managed outside the web UI (for example, `vellum daemon start`).

## Database

This project uses [Drizzle ORM](https://orm.drizzle.team/) for database management.

```bash
# Push schema changes to database
bun run db:push

# Preview schema changes (diff against main branch)
bun run db:push:preview
```

## Cloud Provisioning

When deploying assistant instances to cloud compute (GCP), the startup script automatically installs:

- **Bun** runtime
- **Node packages** via `bun install`
- **Chromium browser** via `bunx playwright install --with-deps chromium` (for headless browser tools)

The cloud compute provisioning path is currently mostly disabled in routes, but the startup script is ready for when it is re-enabled. See [headless browser tools docs](../assistant/docs/headless-browser-tools.md) for details.

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Styling**: Tailwind CSS v4
- **Database**: PostgreSQL with Drizzle ORM
- **AI**: Anthropic Claude
- **Infrastructure**: Google Cloud (Compute Engine, Cloud Storage)

## Project Structure

```
web/
├── src/
│   ├── app/           # Next.js App Router pages and API routes
│   ├── components/    # React components
│   └── lib/           # Utilities, database, GCP helpers
│       ├── db.ts      # Database connection and queries
│       └── schema.ts  # Drizzle schema definitions
└── public/            # Static assets
```
