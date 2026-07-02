# Web App — Agent Instructions

Applies to all code under `clients/web/`. For broader patterns see [`clients/AGENTS.md`](../AGENTS.md) and root [`AGENTS.md`](../../AGENTS.md).

## Conventions and style

Read these before making changes:

- **[`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md)** — Architecture, code organization, component patterns, framework strategy, data fetching, testing.
- **[`docs/STATE_MANAGEMENT.md`](./docs/STATE_MANAGEMENT.md)** — Zustand stores, atomic selectors, TanStack Query, the no-`useReducer` rule.
- **[`docs/EVENT_BUS.md`](./docs/EVENT_BUS.md)** — Cross-domain push signals (SSE, app lifecycle, network). Single connection, typed events, no per-component `visibilitychange` handlers.
- **[`docs/STYLE_GUIDE.md`](./docs/STYLE_GUIDE.md)** — Naming, imports, TypeScript, component authoring, formatting.
- **[`docs/CONVENTIONS.md` — Platform gating](./docs/CONVENTIONS.md#platform-gating)** — The `usePlatformGate()` hook, the five user states (platform-hosted vs self-hosted × logged-in vs not), and when to gate/disable/hide platform-dependent UI surfaces.
- **[`docs/CAPACITOR.md`](./docs/CAPACITOR.md)** — Capacitor / iOS patterns: lazy plugin imports, native auth, deep links, autogrowing textareas, streaming watchdogs, OS permission UI, capability detection, keyboard-only affordances. Mandatory reading if any code path you're touching might run inside the iOS WKWebView shell.
- **[`docs/ELECTRON.md`](./docs/ELECTRON.md)** — Electron renderer patterns: `runtime/` wrapper modules for `window.vellum.*`, domain-owned bridge hooks, the three-file dance for new bridge surfaces. Read this if your change touches anything under `src/runtime/` that uses `window.vellum`.
- **[`docs/BACKWARDS_COMPAT.md`](./docs/BACKWARDS_COMPAT.md)** — How the web app version-gates features against the locally-installed assistant/daemon. The `src/lib/backwards-compat/` registry, `useAssistantSupports()` / `assistantSupports()`, read-vs-write fallback rules, and how to add or test a gate. Read this before adding a feature that depends on a new daemon endpoint, wire field, or event shape.

## Common pitfalls

- **Design system first for UI changes.** Always start from
  `@vellumai/design-library` when adding or changing controls, surfaces,
  typography, popovers, inputs, cards, or button/icon affordances. Use existing
  design-library primitives when they are available; only build custom
  components when the design library does not provide an
  appropriate primitive, and call out that choice in the PR body if the UI is
  non-trivial.
- **`conversationId` vs `conversationKey`**: API queries must send `conversationId` (UUID), never `conversationKey`. See [`docs/CONVENTIONS.md` — Conversation identifiers](./docs/CONVENTIONS.md#conversation-identifiers-conversationid-vs-conversationkey).
- **Don't ship cross-route state through outlet context.** React Router outlet context [re-renders every consumer when any field changes](https://reactrouter.com/start/framework/outlet), forces a bundled value through every layout, and silently resolves to `undefined` whenever an intermediate `<Outlet />` (a gate, a wrapper) sits between writer and reader. Cross-route state — auth, lifecycle, selection, feature flags, layout slots — belongs in a Zustand store so consumers can subscribe atomically and so intermediate routes don't break the channel. Use outlet context only for one-shot parent→direct-child wiring with no intermediate routes.
- **HeyAPI generated artifacts**: For **queries**, spread the generated factory into `useQuery()`: `useQuery({ ...xxxOptions(), enabled })` — the generated `useXxxQuery()` hooks do **not** accept TanStack Query options (`enabled`, `select`, `staleTime`). For **mutations**, use the generated hooks directly: `useXxxMutation({ onSuccess })` — they accept all TQ callbacks. Use typed cache helpers (`setXxxQueryData()`) for optimistic writes. See [`docs/CONVENTIONS.md` — Generated artifacts](./docs/CONVENTIONS.md#generated-artifacts-and-when-to-use-each).
- **Server data has one owner: its query cache.** Read server state directly from the TanStack Query cache; never copy it into a Zustand store or `useState` via an effect and then reconcile the two. Stores own only what the server doesn't have yet — the in-flight/optimistic turn. A function that merges server snapshots into client state (named `reconcile*`, `sanitize*`, `merge*Snapshot`, or similar) is the tell that you've double-sourced: the two copies drift, and you end up re-sorting or de-duping on every render to hide it. See [`docs/STATE_MANAGEMENT.md` — Server state vs client state](./docs/STATE_MANAGEMENT.md).
- **Conversation SSE & the chat transcript**: the live conversation transcript is the one place that intentionally maintains a client-owned materialized view of server data — a rolling snapshot seeded from `/messages` and advanced by folding stream events through a pure, idempotent reducer. Before touching transcript rendering, the stream handlers, the rolling-base reducer, optimistic sends, or reconnect/resync, read [`docs/CONVERSATION_SSE.md`](./docs/CONVERSATION_SSE.md).
- **HeyAPI client interceptors**: The daemon, platform, and auth clients have different routing requirements. Daemon SDK requests forward unconditionally to the self-hosted gateway; platform requests use a segment allowlist. Don't share interceptors across clients with different routing needs. Interceptors [chain sequentially](https://heyapi.dev/openapi-ts/clients/fetch#interceptors) — a gate registered after a rewrite interceptor receives the *rewritten* request, so it must check the final URL, not assume platform origin.
- **Type colocation**: Types live with the module that owns them. `src/types/` is only for cross-domain types with no clear owning module. Don't create `-types.ts` files to break circular dependencies — use [`import type`](https://www.typescriptlang.org/docs/handbook/modules/reference.html#type-only-imports-and-exports) instead (erased at compile time, no runtime cycle). See [`docs/CONVENTIONS.md` — Top-level shared directories](./docs/CONVENTIONS.md#top-level-shared-directories).
- **Org-readiness gating for daemon queries**: Platform-mode requests need the `Vellum-Organization-Id` header, which the interceptor reads from the org store. The store hydrates asynchronously after auth, so TanStack Query hooks that mount eagerly must gate on `useIsOrgReady()` via the [`enabled` option](https://tanstack.com/query/latest/docs/framework/react/guides/dependent-queries). See [`docs/STATE_MANAGEMENT.md` — Org-readiness gating](./docs/STATE_MANAGEMENT.md#org-readiness-gating-for-daemon-queries).
- **Don't use bare `Sentry.captureException`** — use `captureError()` from `lib/sentry/capture-error.ts`. It filters transient network errors, logs to console, and captures to Sentry with structured tags. Raw Sentry API is reserved for framework integration points (`RouteErrorBoundary`, `RouterProvider.onError`, `LazyBoundary`). See [`docs/CONVENTIONS.md` — Manual error reporting](./docs/CONVENTIONS.md#manual-error-reporting-from-imperative-code).
- **Local packages: workspace members are served as source; assistant-api is still a copy.** `@vellumai/design-library`, `@vellumai/ipc-contract`, and `@vellumai/local-mode` are `workspace:*` deps resolved to their real source paths, so Vite serves them as source (not prebundled): edits hot-update live and branch switches are picked up with no cache to go stale. React is installed once at the workspace root and shared by every member — do **not** reintroduce `preserveSymlinks`, per-package React installs, or `file:` deps for local packages; that combination caused the two-Reacts white-screen (the `#34771`→`#34773` revert). `@vellumai/assistant-api` is the remaining exception: postinstall copies `assistant/src/api` into web's node_modules, so it *is* prebundled and can go stale on branch switches — `scripts/ensure-fresh-vite.ts` (run by `dev`) clears the cache when that happens; if you still see a stale copy, `rm -rf clients/web/node_modules/.vite` and restart. The copy (and the guard) go away when assistant-api joins the workspace with the assistant package.

When a topic in `docs/CONVENTIONS.md` grows past ~100 lines and has a
coherent boundary, extract it into a `docs/TOPIC.md` sibling with a
short pointer back from `CONVENTIONS.md`. Matches the repo's existing
pattern (`assistant/docs/`, `docs/` at the repo root).

## Stack

- **Build**: [Vite](https://vite.dev/) + [React 19](https://react.dev/blog/2024/12/05/react-19)
- **Routing**: [React Router v7](https://reactrouter.com/) — [data mode](https://reactrouter.com/start/modes) (`createBrowserRouter`), NOT framework mode
- **Client state**: [Zustand](https://zustand.docs.pmnd.rs/) — all shared state uses Zustand stores (see [`docs/STATE_MANAGEMENT.md`](./docs/STATE_MANAGEMENT.md))
- **Server state**: [TanStack Query](https://tanstack.com/query/latest) with [HeyAPI plugin](https://heyapi.dev/openapi-ts/plugins/tanstack-query)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/) via `@tailwindcss/vite`
- **Design system**: `@vellumai/design-library` at [`packages/design-library/`](../../packages/design-library/)
- **Platform**: Web + iOS via [Capacitor](https://capacitorjs.com/) — native code paths must be preserved

## Routing

- Route config: `src/routes.tsx`
- Route constants: `src/utils/routes.ts` — all paths are absolute browser paths
- No `basename` on the router — `/account/*` and `/assistant/*` are explicit top-level branches
- URL paths are part of the contract — bookmarks and deep links depend on them. Don't rename URL patterns without a deprecation period.
- **Route protection**: uses React Router v7 [middleware](https://reactrouter.com/how-to/middleware) (`v8_middleware` future flag), not layout gate components or `useEffect` redirects. Auth is always required — the middleware redirects unauthenticated users to `/account/login`. See [`docs/CONVENTIONS.md` — Route protection via middleware](./docs/CONVENTIONS.md#route-protection-via-middleware).
- **Assistant lifecycle**: `useAssistantLifecycle` runs once in `RootLayout` as a side-effect orchestrator and publishes through Zustand stores under `src/assistant/` — `selection-store` for the active id, `lifecycle-store` for the state-machine phase and stable imperative actions. Every other consumer reads from those stores. See the docstrings on each store for the access pattern.
- **Active-assistant gating**: routes that require a working assistant mount under `<ActiveAssistantGate>` in `src/routes.tsx`. Inside the gate, call `useActiveAssistantId()` — returns `string` (non-null). **Do not add `if (!assistantId) return null;` guards in gated routes**; the gate makes them unreachable. `ChatPage` and `DocumentViewerPage` live outside the gate (they render across lifecycle states) and read the raw store, handling null themselves.
- **Code splitting**: routes use `Component` (not `element`) with the object-based [`lazy` property](https://reactrouter.com/start/data/route-object#lazy) for route-level code splitting. New routes should default to `lazy` unless they're on the primary landing path (chat). See [`docs/CONVENTIONS.md` — Route-level code splitting](./docs/CONVENTIONS.md#route-level-code-splitting).

## Commands

```bash
cd clients/web && bun install            # Install dependencies
cd clients/web && bun run dev            # Vite dev server (port 3000)
cd clients/web && bun run openapi-ts     # Generate API client from OpenAPI specs
cd clients/web && bunx tsc --noEmit      # Type-check
cd clients/web && bun run lint           # Lint
cd clients/web && bun run build          # Production build
cd clients/web && bun test src/path/to/file.test.ts  # Run specific tests
cd clients/web && bun run test:ci       # Run all tests (isolated, CI)
```

## Scope

This package contains only the assistant web app and authentication / identity pages. Marketing pages and admin/internal surfaces are out of scope.
