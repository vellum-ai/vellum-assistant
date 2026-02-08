# Vellum Assistant - Web App

Next.js web application for Vellum Assistant.

## Prerequisites

- Node.js 20+
- npm or bun
- PostgreSQL database

## Development

See the [root README](../README.md) for local development setup instructions.

## Database

This project uses [Drizzle ORM](https://orm.drizzle.team/) for database management.

```bash
# Push schema changes to database
bun run db:push

# Preview schema changes (dry run)
bun run db:push:preview
```

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
