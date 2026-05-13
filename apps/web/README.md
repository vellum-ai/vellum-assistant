# apps/web

Vite + React Router v7 SPA scaffold for the vellum-assistant web app
surfaces (assistant + docs). This is a landing-zone shell only — the
actual platform code is ported in
[LUM-1543](https://linear.app/vellum/issue/LUM-1543/), and the
CI/scripts/env/Sentry porting belongs to
[LUM-1545](https://linear.app/vellum/issue/LUM-1545/). Tracked under
[LUM-1542](https://linear.app/vellum/issue/LUM-1542/).

## Scope of this scaffold

Includes:

- Vite + React Router v7 (library / data-router) SPA shell.
- Placeholder routes mirroring the intended app topology:
  `/conversations/new`, `/conversations/:id`, `/settings/:tab`,
  `/library`, `/library/:slug`.
- A typed runtime/auth adapter interface
  (`src/runtime/auth-adapter.ts`) so the shell does not assume hosted
  Vellum login. Local, self-hosted, and no-login runtimes plug in via
  the same interface.

Explicitly not included:

- Any platform web code (LUM-1543).
- CI workflows or env/Sentry wiring (LUM-1545).
- Real auth, data fetching, or state management.
- Capacitor/iOS wrapper bits (LUM-1544).

## Why Vite + React Router v7 library mode?

LUM-1542 specifies "SPA, routes load without a Next server". React
Router v7 ships two modes — _framework mode_ (Remix-merged,
server-aware) and _library / data-router mode_ (pure client SPA built
around `createBrowserRouter`). Library mode is the one that satisfies
the no-server constraint; framework mode would silently re-introduce a
Node server dependency. See the
[React Router modes overview](https://reactrouter.com/start/modes).

## SSR/build-safe rendering

Even though the SPA does not currently render on a server, this
scaffold deliberately avoids `window` / `localStorage` / `document`
access during initial render of route or layout components. Any
client-only reads belong in `useEffect` or in a runtime adapter
implementation, not in the synchronous render path. This keeps the
door open for future static prerendering or hybrid runtimes without
ad-hoc rewrites. Vite's [SSR
guidance](https://vite.dev/guide/ssr.html) discusses why this matters
even for predominantly-client apps.

## Local development

```bash
bun install
bun run dev        # Vite dev server
bun run build      # Production build to dist/
bun run preview    # Serve the production build
bun run typecheck  # bunx tsc --noEmit
bun run lint       # eslint
```

## Conventions

- Self-contained Bun package: own `bun.lock`, `package.json`,
  `tsconfig.json`, and lint config (see
  [`apps/AGENTS.md`](../AGENTS.md)).
- Exact-version dependency pinning enforced by root `bunfig.toml`.
- TypeScript `NodeNext` module resolution — relative imports use
  `.js` extensions even for `.tsx` sources.
