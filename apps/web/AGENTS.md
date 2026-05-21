# Web App — Agent Instructions

Applies to all code under `apps/web/`. For broader patterns see [`apps/AGENTS.md`](../AGENTS.md) and root [`AGENTS.md`](../../AGENTS.md).

## Conventions and style

Read these before making changes:

- **[`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md)** — Architecture, code organization, component patterns, framework strategy, data fetching, testing.
- **[`docs/STATE_MANAGEMENT.md`](./docs/STATE_MANAGEMENT.md)** — Zustand stores, atomic selectors, TanStack Query, the no-`useReducer` rule.
- **[`docs/STYLE_GUIDE.md`](./docs/STYLE_GUIDE.md)** — Naming, imports, TypeScript, component authoring, formatting.
- **[`docs/CAPACITOR.md`](./docs/CAPACITOR.md)** — Capacitor / iOS patterns: lazy plugin imports, native auth, deep links, autogrowing textareas, streaming watchdogs, OS permission UI, capability detection, keyboard-only affordances. Mandatory reading if any code path you're touching might run inside the iOS WKWebView shell.

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
- **Design system**: `@vellum/design-library` at [`packages/design-library/`](../../packages/design-library/)
- **Platform**: Web + iOS via [Capacitor](https://capacitorjs.com/) — native code paths must be preserved

## Routing

- Route config: `src/routes.tsx`
- Route constants: `src/utils/routes.ts` — all paths are absolute browser paths
- No `basename` on the router — `/account/*` and `/assistant/*` are explicit top-level branches
- URL paths are part of the contract — bookmarks and deep links depend on them. Don't rename URL patterns without a deprecation period.
- **Route protection**: uses React Router v7 [middleware](https://reactrouter.com/how-to/middleware) (`v8_middleware` future flag), not layout gate components or `useEffect` redirects. Auth is always required — the middleware redirects unauthenticated users to `/account/login`. See [`docs/CONVENTIONS.md` — Route protection via middleware](./docs/CONVENTIONS.md#route-protection-via-middleware).
- **Assistant lifecycle**: owned by `ChatLayout`, passed to child routes via [outlet context](https://reactrouter.com/start/framework/outlet). Child routes consume the resolved `assistantId` via `useAssistantContext()` — never hardcode or independently resolve it.
- **Active-assistant gating**: routes that require a working assistant (queries against `/v1/assistants/{id}/...`, anything that reads or writes per-assistant state) are mounted under `<ActiveAssistantGate>` in `src/routes.tsx`. The gate defers child rendering until `assistantId` is non-null AND `assistantState.kind === "active"`, then re-provides a narrowed outlet context. Inside the gate, call `useActiveAssistantContext()` instead of `useAssistantContext()` — the returned `assistantId` is typed `string` (non-null). **Do not add `if (!assistantId) return null;` guards in gated routes** — the gate makes them unreachable. Routes that intentionally render across non-active states (today: `ChatPage`, `DocumentViewerPage`) live outside the gate and keep using `useAssistantContext()`.

## Commands

```bash
cd apps/web && bun install            # Install dependencies
cd apps/web && bun run dev            # Vite dev server (port 3000)
cd apps/web && bun run openapi-ts     # Generate API client from OpenAPI specs
cd apps/web && bunx tsc --noEmit      # Type-check
cd apps/web && bun run lint           # Lint
cd apps/web && bun run build          # Production build
cd apps/web && bun test src/path/to/file.test.ts  # Run specific tests
cd apps/web && bun run test:ci       # Run all tests (isolated, CI)
```

## Scope

This package contains only the assistant web app and authentication / identity pages. Marketing pages and admin/internal surfaces are out of scope.
