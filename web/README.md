# Vellum Assistant - Web App

Next.js web application for Vellum Assistant.

## Prerequisites

- Node.js 20+
- npm or bun
- PostgreSQL database

## Development

See the [root README](../README.md) for local development setup instructions.

## Architecture

The web app is a thin proxy layer. All chat, attachments, and channel delivery state live in the assistant runtime. The web app stores only assistant metadata, auth, and channel-account configuration in Postgres.

### Runtime Client

Every assistant-facing API route proxies through a single `RuntimeClient` abstraction (`src/lib/runtime/client.ts`). The runtime URL is resolved per-assistant via `resolveRuntime()`.

Environment variables:

- `ASSISTANT_CONNECTION_MODE` — `local` (default) or `cloud`.
- `LOCAL_DAEMON_SOCKET_PATH` — Unix socket path for local mode (default: `~/.vellum/vellum.sock`).

### Assistant Auth

Assistant-initiated routes (e.g. `/api/assistants/[id]/setup-email`, `/api/assistants/[id]/set-avatar`) authenticate with hashed bearer tokens stored in the `assistant_auth_tokens` table. Plaintext keys are never stored.

## Database

This project uses [Drizzle ORM](https://orm.drizzle.team/) for database management.

Postgres stores:
- Assistant metadata (`assistants`)
- Channel account config (`assistant_channel_accounts`, `assistant_channel_contacts`)
- Auth tables (`user`, `session`, `account`, `verification`)
- Assistant auth tokens (`assistant_auth_tokens`)
- API keys (`api_keys`)

Chat messages and attachments are **not** stored in Postgres — they live in the assistant runtime's SQLite database.

```bash
# Push schema changes to database
bun run db:push

# Preview schema changes (diff against main branch)
bun run db:push:preview
```

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Styling**: Tailwind CSS v4
- **Database**: PostgreSQL with Drizzle ORM
- **AI**: Anthropic Claude
- **Infrastructure**: Google Cloud (Compute Engine)

## Project Structure

```
web/
├── src/
│   ├── app/           # Next.js App Router pages and API routes
│   ├── components/    # React components
│   └── lib/           # Utilities, database, runtime client
│       ├── db.ts      # Database connection and queries
│       ├── schema.ts  # Drizzle schema definitions
│       └── runtime/   # RuntimeClient abstraction
└── public/            # Static assets
```
