# Web App — Agent Instructions

Applies to all code under `apps/web/`. Subordinate to [`apps/AGENTS.md`](../AGENTS.md) and root [`AGENTS.md`](../../AGENTS.md).

## Conventions and style

Read these before making changes:

- **[`CONVENTIONS.md`](./CONVENTIONS.md)** — Architecture, code organization, state management, component patterns, framework strategy, data fetching, testing.
- **[`STYLE_GUIDE.md`](./STYLE_GUIDE.md)** — Naming, imports, TypeScript, component authoring, formatting.

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

### Do not bring over upstream tech debt

A faithful port is about preserving **behavior and feature parity**, not preserving every implementation choice. The platform repo was Next.js + Server Components + a different state model. This repo is Vite + React Router v7 + Zustand + TanStack Query. The stack changed; the code should change with it.

This is an **open-source repo**. We're publicly setting an example for how to build a React app well — convention, style guide, and patterns should align with what [React](https://react.dev/), [React Router](https://reactrouter.com/), and major OSS players recommend, not with whatever the platform repo happened to do.

When porting code or reviewing drift PRs:

- **Apply React-idiomatic patterns**, not platform-idiomatic ones. Examples: prefer [adjust-state-during-render](https://react.dev/reference/react/useState#storing-information-from-previous-renders) over `useEffect` for state synchronization; prefer [`key` resets](https://react.dev/learn/you-might-not-need-an-effect#resetting-all-state-when-a-prop-changes) over manual cleanup effects; follow [React 19 patterns](https://react.dev/blog/2024/12/05/react-19) (Context as provider, ref as prop, `use()` for promises) — see also [`CLAUDE.md` — React conventions](../../CLAUDE.md).
- **If a bot review (Codex, Devin, vex-assistant-bot, etc.) flags a real issue in code you just ported, fix it.** Don't dismiss findings as "matches upstream" — that's exactly the tech debt this rule exists to stop. The upstream platform repo will be deprecated; we do not need to mirror its bugs.
- **If a refactor is called for, do it or ticket it.** Small refactors (extract a helper, replace `useEffect` with derived state, rename for clarity) belong in the port PR. Large refactors (rewrite a hook architecture, change a state management approach) get a separate Linear issue tracked in the [Web App Repo Move project](https://linear.app/vellum/project/web-app-repo-move-platform-vellum-assistant-1b8cd4f8-49cf-4b7b-b8e9-98b92046d2c3).
- **If something is just completely wrong, fix it.** Same PR if small and obviously correct, separate PR + Linear issue if it warrants discussion.
- **PR descriptions should call out divergences from the platform implementation** so reviewers understand what changed and why. A drift port that mirrors platform exactly is unusual; we expect deltas because the stack and conventions are different.
