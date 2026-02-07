# Vellum Assistant

AI-powered assistant platform by Vellum.

## Getting Started

### Prerequisites

- Node.js 20+
- npm or bun

### Environment Variables

Copy `.env.example` to `.env.local` and fill in the required values:

```bash
cp .env.example .env.local
```

Required variables:
- `DATABASE_URL` - Neon PostgreSQL connection string
- `ANTHROPIC_API_KEY` - For AI capabilities
- `GCP_SA_KEY` - Google Cloud service account (for compute/storage)

### Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Database Migrations

```bash
npm run db:migrate
```

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Styling**: Tailwind CSS v4
- **Database**: Neon (PostgreSQL)
- **AI**: Anthropic Claude
- **Infrastructure**: Google Cloud (Compute Engine, Cloud Storage)
- **Deployment**: Vercel

## Project Structure

```
src/
├── app/           # Next.js App Router pages and API routes
├── components/    # React components
└── lib/           # Utilities, database, GCP helpers
db/
└── migrations/    # SQL migration files
editor-templates/  # Agent editor page templates
public/            # Static assets
```

## License

Proprietary - Vellum AI
