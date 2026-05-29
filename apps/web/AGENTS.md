# Web App — Agent Instructions

Applies to all code under `apps/web/`. For broader patterns see [`apps/AGENTS.md`](../AGENTS.md) and root [`AGENTS.md`](../../AGENTS.md).

## Conventions and style

Read these before making changes:

- **[`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md)** — Architecture, code organization, component patterns, framework strategy, data fetching, testing.
- **[`docs/STATE_MANAGEMENT.md`](./docs/STATE_MANAGEMENT.md)** — Zustand stores, atomic selectors, TanStack Query, the no-`useReducer` rule.
- **[`docs/EVENT_BUS.md`](./docs/EVENT_BUS.md)** — Cross-domain push signals (SSE, app lifecycle, network). Single connection, typed events, no per-component `visibilitychange` handlers.
- **[`docs/STYLE_GUIDE.md`](./docs/STYLE_GUIDE.md)** — Naming, imports, TypeScript, component authoring, formatting.
- **[`docs/CAPACITOR.md`](./docs/CAPACITOR.md)** — Capacitor / iOS patterns: lazy plugin imports, native auth, deep links, autogrowing textareas, streaming watchdogs, OS permission UI, capability detection, keyboard-only affordances. Mandatory reading if any code path you're touching might run inside the iOS WKWebView shell.
- **[`docs/ELECTRON.md`](./docs/ELECTRON.md)** — Electron renderer patterns: `runtime/` wrapper modules for `window.vellum.*`, domain-owned bridge hooks, the three-file dance for new bridge surfaces. Read this if your change touches anything under `src/runtime/` that uses `window.vellum`.

## Common pitfalls

- **`conversationId` vs `conversationKey`**: API queries must send `conversationId` (UUID), never `conversationKey`. See [`docs/CONVENTIONS.md` — Conversation identifiers](./docs/CONVENTIONS.md#conversation-identifiers-conversationid-vs-conversationkey).

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
- **Assistant lifecycle**: the side-effect orchestrator `useAssistantLifecycle` runs once in `RootLayout` and publishes everything through Zustand stores under `src/assistant/`:
  - `useAssistantSelectionStore.use.activeAssistantId()` — the resolved id, or `null` while the lifecycle is still loading. **Never hardcode or independently resolve it.**
  - `useAssistantLifecycleStore.use.assistantState()` — the discriminated state machine phase (`loading` / `initializing` / `cleaning_up` / `retired` / `platform_hosted` / `self_hosted` / `awaiting_version_selection` / `active` / `error`).
  - `useAssistantLifecycleStore.use.{checkAssistant,retryAssistant,hatchVersion}()` — stable imperative actions registered by the hook on mount. Call them via `.getState()` from event handlers.

  `ChatLayout` exposes a narrow `ChatLayoutContextValue` outlet context for header-slot wiring only (`setTopBarCenter` / `setTopBarRightSlot` / `setOnSearchClick`) — read via `useChatLayoutContext()` from `@/components/layout/chat-layout-context`. No assistant lifecycle rides on outlet context anymore.
- **Active-assistant gating**: routes that require a working assistant (queries against `/v1/assistants/{id}/...`, anything that reads or writes per-assistant state) are mounted under `<ActiveAssistantGate>` in `src/routes.tsx`. The gate defers child rendering until the selection store has a non-null id AND the lifecycle store reports `assistantState.kind === "active"`. Inside the gate, call `useActiveAssistantId()` from `@/assistant/use-active-assistant-id` — the returned `assistantId` is typed `string` (non-null) and asserts the gate is in scope. **Do not add `if (!assistantId) return null;` guards in gated routes** — the gate makes them unreachable. `ChatPage` lives outside the gate because it intentionally renders lifecycle screens (setup, cleanup, version selection) across non-active states; it reads `useAssistantSelectionStore.use.activeAssistantId()` and `useAssistantLifecycleStore.use.assistantState()` directly. `DocumentViewerPage` also lives outside the gate and treats a null id as "still resolving" (loading state), not as an error.
- **Code splitting**: routes use `Component` (not `element`) with the object-based [`lazy` property](https://reactrouter.com/start/data/route-object#lazy) for route-level code splitting. New routes should default to `lazy` unless they're on the primary landing path (chat). See [`docs/CONVENTIONS.md` — Route-level code splitting](./docs/CONVENTIONS.md#route-level-code-splitting).

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
