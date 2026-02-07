# Vellum Assistant

AI-powered assistant platform by Vellum.

## Getting Started

### Prerequisites

- Node.js 20+
- npm or bun
- PostgreSQL database

### Environment Variables

Copy `.env.example` to `.env.local` and fill in the required values:

```bash
cp .env.example .env.local
```

Required variables:
- `DATABASE_URL` - PostgreSQL connection string
- `ANTHROPIC_API_KEY` - For AI capabilities
- `GCP_SA_KEY` - Google Cloud service account (for compute/storage)

### Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Database

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
src/
├── app/           # Next.js App Router pages and API routes
├── components/    # React components
└── lib/           # Utilities, database, GCP helpers
    ├── db.ts      # Database connection and queries
    └── schema.ts  # Drizzle schema definitions
drizzle/           # Generated migrations
public/            # Static assets
```

## License

Proprietary - Vellum AI
