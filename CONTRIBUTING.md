# Contributing to Vellum Assistant

Thank you for your interest in contributing to Vellum Assistant! This guide will help you get started.

## Getting Started

### Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js 20+** - [Download](https://nodejs.org/)
- **npm** (comes with Node.js) or **bun** - [Bun Installation](https://bun.sh/)
- **PostgreSQL** - [Download](https://www.postgresql.org/download/) or use a cloud provider
- **Google Cloud CLI** (for local development) - [Installation](https://cloud.google.com/sdk/docs/install)
- **Git** - [Download](https://git-scm.com/)

### Initial Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/vellum-ai/vellum-assistant.git
   cd vellum-assistant
   ```

2. **Run the setup script**

   ```bash
   ./setup.sh
   ```

   This will install all dependencies in the `web/` directory.

3. **Set up environment variables**

   ```bash
   cd web
   cp ../.env.example .env.local
   ```

   Edit `.env.local` and fill in the required values:
   - `DATABASE_URL` - Your PostgreSQL connection string
   - `ANTHROPIC_API_KEY` - Your Anthropic API key
   - `GCS_BUCKET_NAME` - Google Cloud Storage bucket name
   - `APP_URL` - Usually `http://localhost:3000` for local dev

4. **Authenticate with Google Cloud (for local development)**

   ```bash
   gcloud auth application-default login
   ```

5. **Set up the database**

   ```bash
   npm run db:push
   ```

   This will create the database schema.

6. **Start the development server**

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000) in your browser.

## Development Workflow

### Making Changes

1. **Create a new branch**

   ```bash
   git checkout -b feature/your-feature-name
   ```

   Use a descriptive branch name:
   - `feature/` for new features
   - `fix/` for bug fixes
   - `docs/` for documentation
   - `chore/` for maintenance tasks
   - `perf/` for performance improvements

2. **Make your changes**

   Follow the project structure and coding conventions (see below).

3. **Test your changes**

   ```bash
   npm run lint        # Check for linting errors
   npm run type-check  # Check for TypeScript errors
   npm run build       # Ensure the build succeeds
   ```

4. **Commit your changes**

   Write clear, concise commit messages following [Conventional Commits](https://www.conventionalcommits.org/):

   ```
   feat: add user authentication
   fix: resolve database connection timeout
   docs: update setup instructions
   chore: upgrade dependencies
   ```

5. **Push your branch**

   ```bash
   git push origin feature/your-feature-name
   ```

6. **Open a Pull Request**

   Go to the repository on GitHub and open a PR from your branch to `main`.

### Pull Request Guidelines

- **Title**: Use conventional commit format (`feat:`, `fix:`, etc.)
- **Description**: Clearly explain what your PR does and why
- **Link issues**: Reference any related issues with `Closes #123`
- **Keep it focused**: One feature/fix per PR when possible
- **Tests**: Add tests if applicable (when test infrastructure is set up)
- **Documentation**: Update docs if your changes affect user-facing behavior

## Project Structure

```
vellum-assistant/
├── web/                    # Next.js web application
│   ├── src/
│   │   ├── app/           # Next.js App Router pages and API routes
│   │   │   ├── api/       # API endpoints
│   │   │   │   ├── agents/         # Agent management
│   │   │   │   ├── api-keys/       # API key management
│   │   │   │   └── webhooks/       # Webhook handlers
│   │   │   ├── agents/    # Agent list page
│   │   │   └── ...        # Other pages
│   │   ├── components/    # React components
│   │   │   ├── Layout.tsx           # Main layout
│   │   │   ├── Onboarding/          # Onboarding flow
│   │   │   └── RightPanel/          # Agent details panel
│   │   └── lib/           # Utilities and helpers
│   │       ├── db.ts      # Database queries (Drizzle ORM)
│   │       ├── schema.ts  # Database schema
│   │       ├── gcp.ts     # Google Cloud Platform helpers
│   │       └── auth.tsx   # Authentication context
│   ├── drizzle/           # Generated database migrations
│   ├── public/            # Static assets
│   └── package.json
├── platform/              # Infrastructure (Terraform, Kubernetes)
├── editor-templates/      # Agent editor templates
├── .github/               # GitHub Actions workflows
└── setup.sh               # Setup script
```

## Coding Conventions

### TypeScript

- Use TypeScript for all new code
- Prefer interfaces over types for object shapes
- Use strict type checking (already enabled)
- Avoid `any` - use `unknown` if you're unsure

### React & Next.js

- Use functional components with hooks
- Use `"use client"` directive only when necessary (client-side state, browser APIs)
- Keep server components as the default
- Use Next.js App Router conventions (`page.tsx`, `route.ts`, `layout.tsx`)

### Styling

- Use Tailwind CSS for styling
- Follow existing utility class patterns
- Use dark mode variants where appropriate (`dark:`)
- Keep inline styles minimal

### Database

- Use Drizzle ORM for all database operations
- Define schema changes in `web/src/lib/schema.ts`
- Use `npm run db:generate` to generate migrations
- Test migrations locally before pushing

### API Routes

- Return appropriate HTTP status codes
- Use consistent error response format: `{ error: "message" }`
- Add proper error handling with try-catch
- Log errors server-side with context
- **TODO**: Add authentication middleware (see SECURITY.md)

### Git Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `chore:` - Maintenance tasks
- `perf:` - Performance improvements
- `refactor:` - Code refactoring
- `test:` - Adding tests
- `style:` - Code style changes (formatting, etc.)

## Available Scripts

In the `web/` directory:

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run lint` - Run ESLint
- `npm run type-check` - Run TypeScript type checking
- `npm run db:generate` - Generate database migrations
- `npm run db:migrate` - Run database migrations
- `npm run db:push` - Push schema changes to database (dev)
- `npm run db:studio` - Open Drizzle Studio (database GUI)

## Common Tasks

### Adding a New Database Table

1. Add the table definition to `web/src/lib/schema.ts`
2. Generate a migration: `npm run db:generate`
3. Review the generated migration in `web/drizzle/`
4. Apply the migration: `npm run db:migrate` (or `npm run db:push` for dev)

### Adding a New API Endpoint

1. Create a `route.ts` file in the appropriate directory under `web/src/app/api/`
2. Export `GET`, `POST`, `PATCH`, `DELETE`, etc. as async functions
3. Add proper error handling and logging
4. **Important**: Add authentication (see SECURITY.md for guidelines)

### Adding a New Page

1. Create a `page.tsx` file in the appropriate directory under `web/src/app/`
2. Use server components by default, add `"use client"` only if needed
3. Import and use existing components from `web/src/components/`

## Testing

### Current State

Test infrastructure is not yet set up. When adding tests:

- Write tests alongside your code
- Use descriptive test names
- Test edge cases and error conditions
- Run `npm test` before pushing

## Getting Help

- **Documentation**: Check the [README](./README.md) and [web/README.md](./web/README.md)
- **Issues**: Search existing [issues](https://github.com/vellum-ai/vellum-assistant/issues)
- **Discord**: Join our community (link TBD)
- **Email**: Reach out to the team (contact TBD)

## Code of Conduct

- Be respectful and inclusive
- Welcome newcomers and help them get started
- Focus on constructive feedback
- Assume good intentions

## Security

If you discover a security vulnerability, please **do not** open a public issue. Instead, email security@vellum.ai (or the appropriate contact) privately.

See [SECURITY.md](./SECURITY.md) for more information.

## License

By contributing to Vellum Assistant, you agree that your contributions will be licensed under the same license as the project (Proprietary - Vellum AI).

---

Thank you for contributing! 🎉
