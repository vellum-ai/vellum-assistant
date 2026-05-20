# Web App — Agent Instructions

Applies to all code under `apps/web/`. Subordinate to [`apps/AGENTS.md`](../AGENTS.md) and root [`AGENTS.md`](../../AGENTS.md).

## Conventions and style

Read these before making changes:

- **[`CONVENTIONS.md`](./CONVENTIONS.md)** — Architecture, code organization, state management, component patterns, framework strategy, data fetching, testing.
- **[`STYLE_GUIDE.md`](./STYLE_GUIDE.md)** — Naming, imports, TypeScript, component authoring, formatting.
- **[`CAPACITOR.md`](./CAPACITOR.md)** — Capacitor / iOS patterns: lazy plugin imports, native auth, deep links, autogrowing textareas, streaming watchdogs, OS permission UI, capability detection, keyboard-only affordances. Mandatory reading if any code path you're touching might run inside the iOS WKWebView shell.

## Stack

- **Build**: [Vite](https://vite.dev/) + [React 19](https://react.dev/blog/2024/12/05/react-19)
- **Routing**: [React Router v7](https://reactrouter.com/) — [data mode](https://reactrouter.com/start/modes) (`createBrowserRouter`), NOT framework mode
- **Client state**: [Zustand](https://zustand.docs.pmnd.rs/) — all shared state uses Zustand stores (see [CONVENTIONS.md — State management](./CONVENTIONS.md#state-management))
- **Server state**: [TanStack Query](https://tanstack.com/query/latest) with [HeyAPI plugin](https://heyapi.dev/openapi-ts/plugins/tanstack-query)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/) via `@tailwindcss/vite`
- **Design system**: `@vellum/design-library` at [`packages/design-library/`](../../packages/design-library/)
- **Platform**: Web + iOS via [Capacitor](https://capacitorjs.com/) — native code paths must be preserved

## Routing

- Route config: `src/routes.tsx`
- Route constants: `src/utils/routes.ts` — all paths are absolute browser paths
- No `basename` on the router — `/account/*` and `/assistant/*` are explicit top-level branches
- Routes must match the platform repo exactly during migration (no URL changes)
- **Route protection**: uses React Router v7 [middleware](https://reactrouter.com/how-to/middleware) (`v8_middleware` future flag), not layout gate components or `useEffect` redirects. Auth is always required — the middleware redirects unauthenticated users to `/account/login`. See [CONVENTIONS.md — Route protection via middleware](./CONVENTIONS.md#route-protection-via-middleware).
- **Assistant lifecycle**: owned by `ChatLayout`, passed to child routes via [outlet context](https://reactrouter.com/start/framework/outlet). Child routes consume the resolved `assistantId` via `useAssistantContext()` — never hardcode or independently resolve it.

## Commands

```bash
cd apps/web && bun install            # Install dependencies
cd apps/web && bun run dev            # Vite dev server (port 3000)
cd apps/web && bun run openapi-ts     # Generate API client from OpenAPI specs
cd apps/web && bunx tsc --noEmit      # Type-check
cd apps/web && bun run lint           # Lint
cd apps/web && bun run build          # Production build
cd apps/web && bun test src/path/to/file.test.ts  # Run specific tests
```

## Migration status

This app is being migrated from [`vellum-assistant-platform/web/`](https://github.com/vellum-ai/vellum-assistant-platform). During migration:

- **Faithful copy, not simplification.** Port real implementations, not stubs. All Capacitor/native code paths must be preserved.
- **Convention compliance on arrival.** Apply this repo's naming (kebab-case), import conventions (`.js` extensions, `@/` aliases), and directory structure as code is ported.
- **No marketing or admin pages.** Only the assistant web app and auth/identity pages are migrating.
