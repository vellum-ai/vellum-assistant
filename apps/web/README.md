# apps/web

Vite + [React Router v7](https://reactrouter.com/) SPA for the
Vellum assistant web app (chat, settings, library, docs).

## Stack

- [Vite](https://vite.dev/) for dev server and build.
- [React 19](https://react.dev/) +
  [React Router v7](https://reactrouter.com/start/modes) in
  **library / data-router mode** (`createBrowserRouter` +
  `<RouterProvider>`).
- [Zustand](https://zustand.docs.pmnd.rs/) for shared client state
  (messages, streaming, interactions, conversations).
- [TanStack React Query](https://tanstack.com/query/latest) for server
  state (API calls, caching, mutations).
- [HeyAPI](https://heyapi.dev/) for OpenAPI client generation with
  React Query plugin.
- TypeScript with `NodeNext` module resolution — relative imports use
  `.js` extensions even for `.tsx` sources.
- Bun for dependency management; self-contained `bun.lock` per
  [`apps/AGENTS.md`](../AGENTS.md).

## Local development

### With `vel up` (recommended)

The `vel up web` command in the
[vellum-assistant-platform](https://github.com/vellum-ai/vellum-assistant-platform)
repo starts all required services:

```bash
vel up web
```

This starts:
1. Docker Compose services (Postgres, Valkey, SeaweedFS, Caddy edge proxy)
2. Django backend on `localhost:8000`
3. **This Vite dev server on `localhost:3001`**
4. Caddy edge proxy on `localhost:3000` (canonical browser entry point)

The Caddy proxy routes:
- `/v1/*`, `/_allauth/*`, `/accounts/*` -> Django `:8000`
- Everything else -> Vite `:3001`

Browse to **http://localhost:3000** (not :3001 directly) so auth
cookies and API calls route correctly.

### Without `vel up` (standalone)

If you need to run the web app without the full `vel up` orchestration
(e.g., working on pure UI without backend):

```bash
cd apps/web
bun install
bun run openapi-ts  # generate API client from OpenAPI schemas (required before typecheck/dev)
bun run dev        # Vite dev server on localhost:3001
```

To connect to a running Django backend, ensure the Caddy edge proxy is
running (via `docker compose up edge-proxy` in the platform repo) or
configure your browser to send API requests to `localhost:8000`
directly.

### Other commands

```bash
bun run build      # Production build to dist/
bun run preview    # Serve the production build locally
bun run typecheck  # bunx tsc --noEmit
bun run lint       # eslint
```

## Architecture

See [`CONVENTIONS.md`](./CONVENTIONS.md) for code organization
(domain-based architecture), state management patterns (Zustand +
React Query), component conventions, and framework strategy.

See [`STYLE_GUIDE.md`](./STYLE_GUIDE.md) for naming, imports,
TypeScript rules, and formatting.

## Directory structure

```
src/
  App.tsx                    # root layout component
  main.tsx                   # entry point (createRoot, RouterProvider)
  routes.tsx                 # route tree (createBrowserRouter)
  domains/                   # business domain modules
    messages/                # message lifecycle
    conversations/           # conversation CRUD, grouping, selection
    streaming/               # SSE transport, event parsing
    interactions/            # user-facing prompts
  hooks/                     # cross-domain shared hooks
  utils/                     # cross-domain shared utilities
  types/                     # cross-domain shared types
  lib/                       # configured third-party wrappers
  runtime/                   # framework adapters, platform bridges
  components/                # cross-domain shared UI
  pages/                     # route-level page components
  generated/                 # auto-generated code (HeyAPI) — gitignored
```

## Path alias

Use `@/` to import from `src/`:

```ts
import { useMessageStore } from "@/domains/messages/use-message-store.js";
```

Configured in both `vite.config.ts` (`resolve.alias`) and
`tsconfig.json` (`paths`) for editor support.

## Why library mode?

React Router v7 ships two
[modes](https://reactrouter.com/start/modes): _library / data-router_
mode (pure-client SPA built around `createBrowserRouter`) and
_framework_ mode (file-based routes, generated types, per-route code
splitting).

Library mode is the established React SPA pattern. Fewer conventions
to learn, fewer build-time plugins, no generated types directory — the
more recognizable shape for contributors. Framework mode is a
defensible alternative when the app grows enough that per-route code
splitting becomes worth its conventions; the React Router API used in
day-to-day code (`<Link>`, `<Outlet>`, `useParams`, `useNavigate`) is
the same in both modes, so switching later is a restructure rather
than a rewrite.

## Runtime/auth adapter seam

[`src/runtime/auth-adapter.ts`](src/runtime/auth-adapter.ts) defines a
typed `RuntimeAuthAdapter` interface (`ensureSession` +
`getAuthHeader`) so the shell does not hard-code hosted Vellum login.
Hosted, local, self-hosted, and Electron runtimes plug in via the same
interface from their respective hosts.

## SSR/build-safe rendering

Even though this is an SPA, route and layout components must not
access `window` / `localStorage` / `document` during synchronous
render. Client-only reads belong in `useEffect` or in a runtime
adapter implementation. This keeps the door open for future static
prerendering or hybrid runtimes. See Vite's
[SSR guidance](https://vite.dev/guide/ssr.html) for the underlying
reasoning.
