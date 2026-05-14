# apps/web

> ## Status: scaffold in progress
>
> This directory is the future open-source home for the Vellum web
> app. **No application code lives here yet** — only the Vite + React
> Router v7 toolchain, an empty shell, and placeholder routes that
> exist to validate the build.
>
> The live web app is currently maintained in a separate, non-public
> repository and will land here as the migration completes. Feature
> work, bug fixes, and other contributions for the web app are not
> accepted in `apps/web/` during the scaffold phase — PRs that add
> product features or non-scaffold code will be redirected.

Vite + [React Router v7](https://reactrouter.com/) SPA for the
vellum-assistant web app surfaces (assistant + docs).

## Stack

- [Vite](https://vite.dev/) for dev server and build.
- [React 19](https://react.dev/) +
  [React Router v7](https://reactrouter.com/start/modes) in
  **library / data-router mode** (`createBrowserRouter` +
  `<RouterProvider>`).
- TypeScript with `NodeNext` module resolution — relative imports use
  `.js` extensions even for `.tsx` sources.
- Bun for dependency management; self-contained `bun.lock` per
  [`apps/AGENTS.md`](../AGENTS.md).

## Why library mode?

React Router v7 ships two
[modes](https://reactrouter.com/start/modes): _library / data-router_
mode (pure-client SPA built around `createBrowserRouter`) and
_framework_ mode (file-based routes, generated types, per-route code
splitting; can be configured to produce a static SPA via
[`ssr: false`](https://reactrouter.com/how-to/spa)).

Library mode is the established React SPA pattern. Fewer conventions
to learn, fewer build-time plugins, no generated types directory — the
more recognizable shape for new contributors to this open source repo.
Framework mode is a defensible alternative when the app grows enough
that per-route code splitting or generated param types become worth
their conventions; the React Router API used in day-to-day code
(`<Link>`, `<Outlet>`, `useParams`, `useNavigate`) is the same in both
modes, so switching later is a restructure rather than a rewrite.

## Runtime/auth adapter seam

[`src/runtime/auth-adapter.ts`](src/runtime/auth-adapter.ts) defines a
typed `RuntimeAuthAdapter` interface (`ensureSession` +
`getAuthHeader`) so the shell does not hard-code hosted Vellum login.
Hosted, local, self-hosted, and Electron runtimes plug in via the same
interface from their respective hosts. No implementation is included
in the scaffold.

## SSR/build-safe rendering

Even though this is an SPA, route and layout components must not
access `window` / `localStorage` / `document` during synchronous
render. Client-only reads belong in `useEffect` or in a runtime
adapter implementation. This keeps the door open for future static
prerendering or hybrid runtimes without ad-hoc rewrites. See Vite's
[SSR guidance](https://vite.dev/guide/ssr.html) for the underlying
reasoning.

## Local development

```bash
bun install
bun run dev        # Vite dev server
bun run build      # Production build to dist/
bun run preview    # Serve the production build
bun run typecheck  # bunx tsc --noEmit
bun run lint       # eslint
```
