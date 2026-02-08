# Vellum Assistant - Web App

Next.js web application for Vellum Assistant.

## Prerequisites

- Node.js 20+
- npm or bun
- PostgreSQL database

## Environment Variables

The following env vars are set automatically by `vel up` with local defaults:
- `DATABASE_URL` - PostgreSQL connection string
- `APP_URL` - App URL for callbacks/webhooks
- `MINIO_ENDPOINT` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` - Local object storage

Optional (set in your shell environment if needed):
- `ANTHROPIC_API_KEY` - For AI capabilities
- `GCP_SA_KEY` - Google Cloud service account (for compute/storage)
- `GCP_PROJECT_ID` - Google Cloud project ID
- `GCS_BUCKET_NAME` - Google Cloud Storage bucket name

## Development

```bash
npm install
vel up
```

Open [http://localhost:3000](http://localhost:3000).

## Database

This project uses [Drizzle ORM](https://orm.drizzle.team/) for database management.

```bash
# Push schema changes to database
npm run db:push

# Generate migrations
npm run db:generate

# Run migrations
npm run db:migrate

# Open Drizzle Studio (database GUI)
npm run db:studio
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
├── drizzle/           # Generated migrations
└── public/            # Static assets
```
