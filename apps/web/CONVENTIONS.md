# Web App — Frontend Conventions

Architectural decisions, patterns, and rationale for the Vellum web app.
Covers code organization, state management, component design, and
framework strategy. For coding style, naming, and import rules see
[`STYLE_GUIDE.md`](./STYLE_GUIDE.md).

Subordinate to [`apps/AGENTS.md`](../AGENTS.md) and root
[`AGENTS.md`](../../AGENTS.md).

---

## Architecture overview

The web app is a **Vite + React Router v7 SPA** using
[library / data-router mode](https://reactrouter.com/start/modes)
(`createBrowserRouter` + `<RouterProvider>`). See
[`apps/web/README.md`](./README.md) for the full stack description and
local development commands.

### Why Data mode, not Framework mode

React Router v7 offers three usage modes — Declarative, Data, and
Framework — each adding features
[at the cost of architectural control](https://reactrouter.com/start/modes).
We chose **Data mode** deliberately:

| Concern | Why Data mode wins |
|---------|-------------------|
| **Open-source distribution** | Standard Vite SPA build (`bun run build` → static `dist/` → serve anywhere). No server runtime, no deployment adapter, no `@react-router/dev` plugin required for consumers. |
| **No framework tax** | The whole reason for leaving Next.js was to stop paying framework overhead we don't use. Framework mode is another framework layer — Data mode is just a library. |
| **No SSR needed** | Framework mode's primary differentiator is SSR/SSG. This app requires auth (no SEO benefit), runs behind Caddy, and has a Django API backend. |
| **Build pipeline control** | Framework mode replaces `@vitejs/plugin-react` with its own Vite plugin. Data mode keeps a standard Vite setup — full control over Tailwind v4 integration, design library resolution, path aliases, etc. |
| **Monorepo flexibility** | Framework mode imposes file structure opinions (`app/`, `routes.ts`, `root.tsx`, `entry.client.tsx`). Data mode lets us keep our own directory layout. |
| **Incremental migration** | Add routes to `createBrowserRouter` one at a time — no Route Module API restructuring required. |

**What we "lose":** type-safe `href` (compile-time link validation). Everything
else — loaders, actions, code splitting (via `lazy` route property), nested
routes — works in Data mode.

References:
- [React Router — Picking a Mode](https://reactrouter.com/start/modes)
- [React Router — Custom Framework (Data Mode)](https://reactrouter.com/start/data/custom)
- [React Router — Framework Adoption from RouterProvider](https://github.com/remix-run/react-router/blob/main/docs/upgrading/router-provider.md) — shows what migrating TO Framework mode entails

### Route-driven component boundaries

Each route should only mount the hooks and state it actually needs.
Avoid "god components" that render on every route with conditional logic
to hide irrelevant sections.

```
routes.tsx
  <App />            ← shared shell (nav, layout, providers)
    <Outlet />
      <ChatPage />           ← mounts chat, streaming, messages
      <LibraryPage />        ← library listing
      <SettingsTabPage />    ← mounts settings-specific state
```

Push hooks down to the route component that needs them. Lift shared
state to the nearest common ancestor — typically a layout route or a
context provider mounted in `<App />`.

References:
- [React — Thinking in React](https://react.dev/learn/thinking-in-react)
- [React Router — Layout Routes](https://reactrouter.com/start/framework/routing#layout-routes)

---

## Code organization

### Organize by domain, not technical layer

Group code by what it does (messages, conversations, streaming,
interactions), not by what it is (hooks, utils, components). The
top-level folder for domain modules is called **`domains/`**.

```
src/
  domains/                         # business domain modules
    messages/                      # message lifecycle
      use-message-store.ts
      use-send-message.ts
      message-handlers.ts
      message-handlers.test.ts
      types.ts
      components/
        chat-body.tsx
    conversations/                 # conversation CRUD, grouping, selection
      use-conversation-store.ts
      use-conversation-loader.ts
      conversation-reducer.ts
      conversation-reducer.test.ts
      types.ts
    streaming/                     # SSE transport, event parsing
      use-stream-store.ts
      stream-transport.ts
      event-parser.ts
      event-types.ts
      handlers/
        message-handlers.ts
        interaction-handlers.ts
        types.ts
    interactions/                   # user-facing prompts
      use-interaction-store.ts
      interaction-state-machine.ts
      interaction-state-machine.test.ts
      types.ts
  hooks/                           # cross-domain shared hooks
    use-is-mobile.ts
    use-visible-viewport.ts
  utils/                           # cross-domain shared utilities
    format.ts
    browser.ts
  types/                           # cross-domain shared types
    window.d.ts
  lib/                             # configured third-party wrappers
    api-client.ts
    csrf.ts
    telemetry.ts
  runtime/                         # framework adapters, platform bridges
    native-auth.ts
    route-adapter.ts
  components/                      # cross-domain shared UI
```

#### Why `domains/` not `features/`

The team chose `domains/` over the more common `features/` because
"features" implies product-level concepts (like "chat" or
"settings") that contain multiple domains. `messages`,
`conversations`, and `streaming` are business domains with distinct
data models and lifecycles — not features. `domains/` is more precise
for a DDD-influenced architecture and signals that each folder
represents a bounded context.

References:
- [Bulletproof React — Project Structure](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md)
- [React Router — Feature Folders](https://reactrouter.com/how-to/file-route-conventions)

### How to decide where the domain split is

Think of domains like database tables, not nested documents. Split by
**lifecycle and reason-to-change**, not by containment:

- **Separate domain if:** it has its own API endpoints, its own data
  model/types, its own state lifecycle, and could be worked on by a
  different developer without merge conflicts.
- **Same domain if:** two things always change together, share the same
  store, and splitting them would create circular cross-imports.
- **Cross-domain imports are normal.** `messages/` importing types from
  `conversations/` is expected. The rule is: **no circular
  dependencies** between domains. If A imports from B AND B imports
  from A, either merge them or hoist the shared code to `types/`.

Examples of correct splits:
- `messages/` vs `conversations/`: messages are created, streamed,
  delta-updated, and compacted — different lifecycle from conversation
  CRUD and grouping.
- `streaming/` vs `messages/`: SSE transport and reconnection logic
  changes for different reasons than message state management.
- `interactions/` vs `turn/`: user-facing prompts (secrets,
  confirmations) have their own state machine, independent from the
  turn lifecycle (idle → sending → receiving → complete).

### Top-level shared directories

Code used across multiple domains lives in top-level shared
directories. If something is domain-specific, it belongs inside
`domains/<name>/`.

| Folder | Purpose | Example contents |
|---|---|---|
| `hooks/` | Cross-domain React hooks | `use-is-mobile.ts`, `use-visible-viewport.ts`, `use-keyboard-shortcuts.ts` |
| `utils/` | Pure utility functions | `format.ts`, `browser.ts`, `network-status.ts`, `stable-id.ts` |
| `types/` | Shared type definitions | `window.d.ts`, `api-types.ts` |
| `lib/` | Configured third-party wrappers | `api-client.ts` (HeyAPI + interceptors), `csrf.ts`, `telemetry.ts` (Sentry), `feature-flags.ts` |
| `runtime/` | Framework adapters and native platform bridges | `route-adapter.ts`, `native-auth.ts`, `native-deep-link.ts`, `app-bridge.ts` |
| `components/` | Cross-domain shared UI | `error-boundary.tsx`, `sign-in-gate.tsx`, `providers.tsx` |

| `generated/` | Auto-generated code (HeyAPI, catalogs) | `heyapi/`, `catalogs/` |

#### Why `lib/` exists

The platform repo has configured third-party wrappers (HeyAPI client
with request/response interceptors, CSRF token management, Sentry
configuration, feature flag providers) that don't fit `utils/` (they
have side effects and configure instances — not pure functions) or
`runtime/` (they're not framework adapters). `lib/` is the standard
home for this category of code.

Reference: [Bulletproof React — `lib/` directory](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md)

### No barrel files

Do not use barrel files (`index.ts` that re-export siblings). Import
from the source file directly. If a genuine need arises in the future,
discuss with the team before adding one.

---

## State management

### Zustand for shared mutable state

Use [Zustand](https://github.com/pmndrs/zustand) for state shared
across multiple components — messages, turn state, interactions,
conversation list, viewer state. Zustand was chosen over Context +
useReducer because:

- **Selector support.** `useStore(selector)` lets each component
  subscribe to only the slice it needs. Context has no selector
  support — every consumer re-renders on any change, which is
  unacceptable during streaming (messages update every ~50ms).
- **Framework-agnostic store definitions.** Store logic is plain
  TypeScript with no React dependency — portable across environments.
- **Existing reducers drop in unchanged.** Reducer functions
  (`turnReducer`, `interactionReducer`, `conversationListReducer`)
  work as Zustand actions with no modification.

```ts
// Good — component only re-renders when its slice changes
const messages = useChatStore((s) => s.messages);

// Avoid — every consumer re-renders on any context change
const { messages } = useContext(ChatContext);
```

References:
- [Zustand docs](https://zustand.docs.pmnd.rs/)
- [Zustand — Auto-generating selectors](https://zustand.docs.pmnd.rs/guides/auto-generating-selectors)

### Zustand store conventions

Each domain owns its store, colocated within the domain folder:
`domains/messages/use-message-store.ts`. File naming follows hook
convention since stores are accessed as hooks: `use-{domain}-store.ts`.

Store creation pattern:

```ts
import { create } from "zustand";
import { messageReducer } from "./message-reducer.js";
import type { MessageState, MessageAction } from "./types.js";

interface MessageStore extends MessageState {
  dispatch: (action: MessageAction) => void;
}

export const useMessageStore = create<MessageStore>((set) => ({
  messages: [],
  // ... initial state
  dispatch: (action) => set((state) => messageReducer(state, action)),
}));
```

Keep store definitions in their domain folder — adding or removing a
domain means adding or removing a folder.

Reference: [Zustand — TypeScript guide](https://zustand.docs.pmnd.rs/guides/typescript)

### useReducer for related state within a component

When two or more pieces of state change together or have
interdependent transitions *within a single component or hook*,
consolidate them into a `useReducer` with typed action events.
Reserve `useState` for independent, single-value state (a boolean
toggle, a text input value).

```ts
// Good — related state transitions are atomic and self-documenting
dispatch({ type: "SHOW_SECRET", requestId, prompt });

// Avoid — multiple setState calls that must stay in sync
setSecretRequestId(requestId);
setSecretPrompt(prompt);
setShowSecretOverlay(true);
```

Extract the reducer into its own file so it can be tested as a pure
function.

Reference: [React — Scaling Up with Reducer and Context](https://react.dev/learn/scaling-up-with-reducer-and-context)

### State machine reducers

State machines (turn state, interaction state) use typed domain events,
not raw setters.

- **Dispatch named events** (`SHOW_SECRET`, `DISMISS_CONFIRMATION`,
  `RESET_ALL`) instead of calling multiple `setState` functions.
- **Guard against stale events.** Check `requestId` matches before
  applying updates.
- **Test the reducer in isolation.** Reducers are pure functions —
  verify transitions with unit tests before relying on integration
  tests.

Reference: [React — useReducer](https://react.dev/reference/react/useReducer)

---

## Component patterns

### Components render UI; hooks perform side effects

If something renders `null` and only performs side effects (`useEffect`
subscriptions, syncing state), it should be a custom hook, not a
component.

```ts
// Good — hook for side-effect-only logic
function useKeyboardShortcuts() {
  useEffect(() => { /* subscribe */ return () => { /* cleanup */ }; }, []);
}

// Avoid — component that renders nothing
function KeyboardShortcuts() {
  useEffect(() => { /* subscribe */ return () => { /* cleanup */ }; }, []);
  return null;
}
```

Reference: [React — Reusing Logic with Custom Hooks](https://react.dev/learn/reusing-logic-with-custom-hooks)

### Thin orchestrator hooks

Top-level hooks that wire multiple domains together should be thin
orchestrators: compose domain hooks, build a shared context object,
delegate work. They should not contain business logic inline.

Signs a hook needs decomposition:
- A single `useCallback` with a switch/if-else over many cases
  -> extract cases into domain handler functions
- Multiple unrelated `useEffect` blocks -> split into focused hooks
- The file exceeds ~300 lines of non-test code

Reference: [React — Reusing Logic with Custom Hooks](https://react.dev/learn/reusing-logic-with-custom-hooks)

### Pure handler functions over inline logic

Extract event-handling logic into pure functions that take a context
object and return results, rather than closing over component state.

```ts
// Good — pure function, easy to unit test
export function handleMessageDelta(
  ctx: StreamHandlerContext,
  event: MessageDeltaEvent
): void {
  ctx.setMessages((prev) => applyDelta(prev, event));
}

// Avoid — inline in useCallback, hard to test in isolation
const handleStreamEvent = useCallback((event) => {
  if (event.type === "message.delta") {
    setMessages((prev) => /* 30 lines of logic */);
  }
}, [/* 15 deps */]);
```

Reference: [React — Keeping Components Pure](https://react.dev/learn/keeping-components-pure)

### Extract sub-components by responsibility, not line count

Inline JSX that has its own concerns (visibility gating, animation,
multi-prop wiring, conditional rendering beyond a one-liner) should be
extracted into a named component. Trivial inline JSX (a single element,
a static label) stays inline.

Reference: [React — Thinking in React: break the UI into a component hierarchy](https://react.dev/learn/thinking-in-react#step-1-break-the-ui-into-a-component-hierarchy)

### Stabilize external callbacks with refs

When a hook receives callbacks that may not be memoized upstream, store
them in refs to keep the consuming `useCallback` identity stable:

```ts
const callbackRef = useRef(onSomeEvent);
callbackRef.current = onSomeEvent;

const stableHandler = useCallback(() => {
  callbackRef.current(/* args */);
}, []);
```

This is the standard workaround until
[`useEffectEvent`](https://react.dev/learn/separating-events-from-effects#declaring-an-effect-event)
ships as stable.

Reference: [React — useCallback: preventing an Effect from firing too often](https://react.dev/reference/react/useCallback#preventing-an-effect-from-firing-too-often)

---

## Framework strategy

### Keep domain logic framework-agnostic

Reducers, pure handler functions, state machines, and domain types must
not import from any framework-specific module (`next/navigation`,
`next/router`, `react-router`, etc.). They should be pure TypeScript
that works in any React environment.

Framework-specific routing calls (`navigate()`, `useParams`,
`useSearchParams`) belong in thin adapter layers or the route components
that wire domains to the framework — not in the domain modules
themselves.

References:
- [React Router v7 — Data Loading](https://reactrouter.com/how-to/data-loading)
- [React — Separating Events from Effects](https://react.dev/learn/separating-events-from-effects)

### URL-driven routing is the target architecture

The target architecture uses URL routing directly via React Router v7
nested routes, eliminating custom navigation state and URL-to-state sync
effects. Each view state maps to a route; the URL is the source of
truth.

References:
- [React Router — Nested Routes](https://reactrouter.com/start/framework/routing#nested-routes)
- [React Router — useSearchParams](https://reactrouter.com/hooks/use-search-params)

### SSR/build-safe rendering

Route and layout components must not access `window` /
`localStorage` / `document` during synchronous render. Client-only
reads belong in `useEffect` or in a runtime adapter implementation.
This keeps the door open for future static prerendering or hybrid
runtimes.

Reference: [Vite — SSR guidance](https://vite.dev/guide/ssr.html)

---

## Design system

### `packages/design-library/`

Domain-agnostic UI primitives (Button, Card, Modal, Typography, etc.)
live in `packages/design-library/` outside `apps/web/`. The package is
consumed as a `file:` dependency and resolved via its `exports` field
in `package.json` — no Vite alias or tsconfig `paths` needed.

```ts
import { Button, Typography } from "@vellum/design-library";
```

Design system components accept props and render UI. They must not
import domain state, feature hooks, or application-specific logic.

References:
- [Node.js — Package exports](https://nodejs.org/api/packages.html#exports)
- [Bun — Workspaces](https://bun.sh/docs/install/workspaces)

---

## Data fetching

### React Query for server state

Use [TanStack React Query](https://tanstack.com/query/latest) for
server-derived data (API calls, caching, background refetching,
mutations). When multiple components need the same data, use a shared
hook with a stable query key — not independent `useState` +
`useEffect` fetch cycles in each consumer.

React Query handles **server state**. Zustand handles **client state**
(UI interactions, streaming state, conversation selections). They do not
overlap.

Why React Query over alternatives:
- [HeyAPI `@tanstack/react-query` plugin](https://heyapi.dev/openapi-ts/plugins/tanstack-query)
  auto-generates type-safe query/mutation hooks from the OpenAPI spec.
  No equivalent plugin exists for SWR (still in proposal stage) or other
  libraries.
- First-class mutation support, optimistic updates, and DevTools.
- 12M+ weekly downloads (2026), most feature-complete option.

References:
- [React Query — Overview](https://tanstack.com/query/latest/docs/framework/react/overview)
- [React Query — Comparison](https://tanstack.com/query/latest/docs/framework/react/comparison)

### HeyAPI for OpenAPI client generation

The API client is generated from the platform's OpenAPI spec using
[HeyAPI (`@hey-api/openapi-ts`)](https://heyapi.dev/). Codegen runs in
this repo — the platform publishes the spec, we generate the client
locally.

Plugins:
- `@tanstack/react-query` — generates `*Options()` helpers for
  `useQuery` / `useMutation` / `useInfiniteQuery`
- `@hey-api/client-fetch` — Fetch-based HTTP client (no Axios/Node
  dependency)
- `@hey-api/typescript` — generates TypeScript types from schemas

Generated output lives in `src/generated/heyapi/`. This directory is
fully auto-generated — do not hand-edit files in it. Run
`bun run openapi-ts` to regenerate.

References:
- [HeyAPI — Configuration](https://heyapi.dev/openapi-ts/configuration)
- [HeyAPI — TanStack Query plugin](https://heyapi.dev/openapi-ts/plugins/tanstack-query)

### Prefer generated clients over hand-written fetch

For backend API routes, use the generated HeyAPI hooks (`*Options()`
helpers with `useQuery` / `useMutation`) over hand-written `fetch`
wrappers. Do not create new direct `fetch()` calls with hardcoded
backend prefixes unless the generated client cannot support the use case
(e.g. SSE/streaming endpoints that need custom `EventSource` handling).
If bypassing, add a comment explaining why.

---

## Testing

- **Test framework:** `bun:test` (`describe`, `it`, `expect`, `mock`).
- **Colocate tests with source.** `message-handlers.test.ts` lives
  alongside `message-handlers.ts`.
- **Test reducers and pure functions in isolation.** They are pure
  functions — unit-test state transitions directly before relying on
  integration tests.
- **Mock at the right boundary.** Mock API clients (`client.get`,
  `client.post`), not `globalThis.fetch`. This catches request-building
  bugs that fetch-level mocks miss.
- **Run tests:** `bun test src/path/to/file.test.ts`

---

## Dead code and cleanup

- **Delete immediately.** When extracting logic into a new module or
  inlining it, remove the original in the same PR.
- **Unrelated dead code spotted during a PR** gets its own separate PR
  opened at the same time — never just filed as an issue and left.
- **No commented-out code.** If code is removed, it lives in git
  history.
- **Audit proactively.** When fixing a convention violation, audit the
  broader codebase for the same violation and fix all instances.
