# Vellum Assistant - Web App

Next.js web application for Vellum Assistant.

## Prerequisites

- Node.js 20+
- npm or bun
- PostgreSQL database
- Google Cloud CLI (for local development with GCS)

## Environment Variables

Copy `.env.example` to `.env.local` and fill in the required values:

```bash
cp ../.env.example .env.local
```

Required variables:
- `DATABASE_URL` - PostgreSQL connection string
- `ANTHROPIC_API_KEY` - For AI capabilities
- `GCS_BUCKET_NAME` - Google Cloud Storage bucket name

For local development, authenticate with GCP using:
```bash
gcloud auth application-default login
```

## Development

```bash
npm install
npm run dev
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
