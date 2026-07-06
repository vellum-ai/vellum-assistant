# clients/web

Vite + [React Router v7](https://reactrouter.com/) SPA for the
Vellum assistant web app (chat, settings, library, docs).

## Stack

- [Vite](https://vite.dev/) for dev server and build.
- [React 19](https://react.dev/) +
  [React Router v7](https://reactrouter.com/start/modes) in
  **library / data-router mode** (`createBrowserRouter` +
  `<RouterProvider>`).
- [Zustand](https://zustand.docs.pmnd.rs/) for shared client state
  (messages, streaming, interactions, conversations). See
  [`docs/STATE_MANAGEMENT.md`](./docs/STATE_MANAGEMENT.md) for store patterns.
- [TanStack React Query](https://tanstack.com/query/latest) for server
  state (API calls, caching, mutations).
- [HeyAPI](https://heyapi.dev/) for OpenAPI client generation with
  React Query plugin.
- TypeScript with `Bundler` module resolution — no `.js` extensions on
  imports (bundler-only package; see [`clients/AGENTS.md`](../AGENTS.md)).
- Bun for dependency management; self-contained `bun.lock` per
  [`clients/AGENTS.md`](../AGENTS.md).

## Local development

```bash
cd clients/web
bun install   # installs the whole workspace
bun run openapi-ts  # generate API client (required before typecheck/dev)
bun run dev         # Vite dev server on localhost:3000
```

### Connecting to a backend

The Vite dev server includes a built-in
[reverse proxy](https://vite.dev/config/server-options#server-proxy)
that forwards API paths (`/v1/*`, `/_allauth/*`, `/accounts/*`) to the
Django backend. This keeps all requests same-origin so session cookies
work automatically — no CORS configuration or HTTPS setup needed.

By default the proxy targets `http://localhost:8000`. To change it,
set `API_PROXY_TARGET` in a `.env` file (see
[`.env.example`](./.env.example)):

```bash
# .env (not committed)
API_PROXY_TARGET=http://localhost:8000
```

Browse to **http://localhost:3000** and log in normally.

> **Note:** Some API endpoints (avatar, feed, assistant state) return
> 404 unless the assistant daemon is running. This is expected in
> frontend-only mode — the core UI and auth flow work without the
> daemon.

### How the proxy works

The client makes relative API requests (e.g. `fetch("/v1/feed")`).
In development, Vite's proxy intercepts these and forwards them to
the backend. In production, an infrastructure reverse proxy (nginx,
cloud LB, etc.) does the same routing. The client code is identical
in both environments — no environment-specific base URLs.

```
Development:   Browser ─► Vite :3000 ─(proxy)─► Django :8000
Production:    Browser ─► Reverse proxy ─► Django
```

Reference: [Vite server.proxy docs](https://vite.dev/config/server-options#server-proxy)

### Other commands

```bash
bun run build      # Production build to dist/
bun run preview    # Serve the production build locally
bun run typecheck  # bunx tsc --noEmit
bun run lint       # eslint
```

## Storybook

[Storybook](https://storybook.js.org/) provides isolated component
development for `clients/web` components — the ones tied to the app
(routing, stores, layout) that don't belong in
`@vellumai/design-library`. Design-system primitives live in their own
Storybook (`packages/design-library`, port 6006).

```bash
cd clients/web
bun run storybook          # dev server → http://localhost:6007
bun run build-storybook    # static build → storybook-static/
```

Stories are colocated next to their components (`*.stories.tsx`).
Autodocs generates prop tables from TypeScript types automatically.

Use the **Theme** toolbar to switch between Light, Dark, and Velvet —
the wiring matches the design library Storybook so components render
with the same `data-theme` tokens they get in the running app. A
`MemoryRouter` decorator wraps every story so components using
`react-router` work without setup.

The Storybook also runs automatically as part of `vel up` (alongside
the design library Storybook on `:6006`) — see the
[`vel` README](https://github.com/vellum-ai/vellum-assistant-platform/blob/main/vel/README.md)
for the multi-service workflow.

## Testing

```bash
bun test                         # run all tests (single process, fast)
bun test src/path/to/file.test.ts  # run one file
bun run test:ci                  # run each file in its own process (CI)
```

Tests use [Bun's built-in test runner](https://bun.sh/docs/test) with
[happy-dom](https://github.com/nicedoc/happy-dom) providing browser
globals (`window`, `document`, `localStorage`, `fetch`, etc.) so
component and hook tests run without a real browser.

### Why `test:ci`?

Bun's
[`mock.module()`](https://bun.sh/docs/test/mocking#mock-module)
mutates a process-global module registry — mocks set in one test file
leak into every subsequent file in the same process. `bun run test:ci`
runs each file in its own subprocess for full isolation. Use it when
the standard `bun test` shows cross-file contamination, or in CI where
deterministic results are required.

## Architecture

See [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md) for code organization
(domain-based architecture), component conventions, and framework strategy.
See [`docs/STATE_MANAGEMENT.md`](./docs/STATE_MANAGEMENT.md) for state
patterns (Zustand + TanStack Query).

See [`docs/STYLE_GUIDE.md`](./docs/STYLE_GUIDE.md) for naming, imports,
TypeScript rules, and formatting.

**Feature boundaries are enforced by lint.** Each folder under
`src/domains/` is meant to be a self-contained feature — its own data,
components, hooks, and tests. When one feature reaches into another's
internals, that creates a hidden coupling: changing the source can
break the consumer, even though they're supposed to be independent.
The custom ESLint rule [`local/no-cross-domain-imports`](./eslint-rules/no-cross-domain-imports.mjs)
fails CI on any new `@/domains/<y>/...` import from inside
`src/domains/<x>/...` when `x !== y`. Existing legacy imports are
listed in [`.cross-domain-allowlist.json`](./.cross-domain-allowlist.json)
while we lift the shared pieces up to the top-level shared directories
(`hooks/`, `stores/`, `utils/`, `types/`, `components/`). That file
shrinks toward zero over time — fix violations rather than adding
entries to it. See [docs/CONVENTIONS.md](./docs/CONVENTIONS.md#how-to-decide-where-the-domain-split-is)
for the full reasoning and the lift-vs-compose decision tree.

## Directory structure

```
src/
  App.tsx                    # root layout component
  main.tsx                   # entry point (createRoot, RouterProvider)
  routes.tsx                 # route tree (createBrowserRouter)
  assistant/                 # core domain — the assistant itself
  stores/                    # app-level Zustand stores (cross-domain)
  domains/                   # feature modules
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
import { useMessageStore } from "@/domains/messages/message-store.js";
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
