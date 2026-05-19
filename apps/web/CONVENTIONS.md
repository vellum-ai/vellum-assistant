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
  stores/                          # app-level Zustand stores (cross-domain)
    viewer-store.ts
    sse-connected-store.ts
  domains/                         # business domain modules
    messages/                      # message lifecycle
      message-store.ts
      use-send-message.ts
      message-handlers.ts
      message-handlers.test.ts
      types.ts
      components/
        chat-body.tsx
    conversations/                 # conversation CRUD, grouping, selection
      conversation-store.ts
      conversation-store.test.ts
      use-conversation-loader.ts
      types.ts
    streaming/                     # SSE transport, event parsing
      stream-store.ts
      stream-transport.ts
      event-parser.ts
      event-types.ts
      handlers/
        message-handlers.ts
        interaction-handlers.ts
        types.ts
    interactions/                   # user-facing prompts
      interaction-store.ts
      interaction-store.test.ts
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

#### Domains do not map 1:1 to routes

Domains are **business capabilities**, not URL segments. A route
composes one or more domains; a domain may be used by zero or more
routes. `conversations/`, `interactions/`, and `subagents/` have no
routes of their own — they are composed by page-level domains
(`chat/`, `home/`) that do map to routes.

The dependency direction is one-way:
`shared → domains → page domains → routes`.

References:
- [Bulletproof React — Project Structure](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md) — `features/` and `app/routes/` are separate top-level folders
- [Feature-Sliced Design — Overview](https://feature-sliced.design/docs/get-started/overview) — "pages" (routes) and "features" (capabilities) are separate layers

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
| `stores/` | App-level Zustand stores (cross-domain state) | `viewer-store.ts`, `sse-connected-store.ts` |
| `hooks/` | Cross-domain React hooks | `use-is-mobile.ts`, `use-visible-viewport.ts`, `use-keyboard-shortcuts.ts` |
| `utils/` | Pure utility functions | `format.ts`, `browser.ts`, `network-status.ts`, `stable-id.ts` |
| `types/` | Shared type definitions | `window.d.ts`, `api-types.ts` |
| `lib/` | Configured third-party wrappers | `api-client.ts` (HeyAPI + interceptors), `csrf.ts`, `telemetry.ts` (Sentry), `feature-flags.ts` |
| `runtime/` | Framework adapters and native platform bridges | `route-adapter.ts`, `native-auth.ts`, `native-deep-link.ts`, `app-bridge.ts` |
| `components/` | Cross-domain shared UI | `error-boundary.tsx`, `sign-in-gate.tsx`, `providers.tsx` |

| `generated/` | Auto-generated code (HeyAPI, catalogs) | `api/`, `catalogs/` |

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
- **Direct named actions.** Store actions are plain functions that
  call `set()` — no dispatchers, no action types, no switch statements.
  See [Zustand store conventions](#zustand-store-conventions).

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
`domains/messages/message-store.ts`. Store files use
`{domain}-store.ts`. Zustand stores are module-level singletons with
both React hook and non-React APIs (`.getState()`, `.setState()`,
`.subscribe()`), so the file describes what the module *is* (a store),
while the exported hook uses the `use` prefix per React's
[Rules of Hooks](https://react.dev/reference/rules/rules-of-hooks).

References:
- [Zustand — TypeScript guide](https://zustand.docs.pmnd.rs/guides/typescript)
- [Bulletproof React — project structure](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md)

Store creation pattern — separate `State` and `Actions` interfaces,
wrap with `createSelectors` for auto-generated per-field hooks:

```ts
import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";
import type { Message } from "./types.js";

// State — the data
export interface MessageState {
  messages: Message[];
  activeThreadId: string | null;
}

// Actions — direct named functions (no dispatch/reducer)
export interface MessageActions {
  addMessage: (message: Message) => void;
  setActiveThread: (threadId: string | null) => void;
  clearMessages: () => void;
}

// Combined store type
export type MessageStore = MessageState & MessageActions;

const useMessageStoreBase = create<MessageStore>()((set) => ({
  messages: [],
  activeThreadId: null,
  addMessage: (message) =>
    set((s) => ({ messages: [...s.messages, message] })),
  setActiveThread: (threadId) =>
    set({ activeThreadId: threadId }),
  clearMessages: () =>
    set({ messages: [], activeThreadId: null }),
}));

export const useMessageStore = createSelectors(useMessageStoreBase);
```

Consumers use `.use.field()` in render bodies and `.getState()` in
callbacks — see
[Reading state: `.use.*` vs `.getState()`](#reading-state-use-vs-getstate).

Keep store definitions in their domain folder — adding or removing a
domain means adding or removing a folder.

References:
- [Zustand — TypeScript guide](https://zustand.docs.pmnd.rs/guides/typescript)
- [Zustand — Auto Generating Selectors](https://zustand.docs.pmnd.rs/learn/guides/auto-generating-selectors)

### Auth state lives in a Zustand store

Auth is cross-domain shared state — used by middleware, route
components, API interceptors, and platform bridges. It lives in a
Zustand store (`stores/auth-store.ts`), not a React Context. This
is critical because:

- **Middleware and loaders** need auth state outside the React tree —
  `useAuthStore.getState()` works anywhere; Context requires a
  component.
- **API interceptors** need to read/write auth state synchronously.
- **Selector support** — components subscribe to only the auth slice
  they need (e.g., `useAuthStore(s => s.isAuthenticated)`).

References:
- [Zustand — Reading/writing state outside components](https://zustand.docs.pmnd.rs/guides/reading-and-writing-state-outside-components)
- [React Router — Middleware](https://reactrouter.com/how-to/middleware)

### Turn state lives in `domains/messaging/turn-store.ts`

Turn lifecycle (sending, thinking, streaming, idle, errored), queue
depth, active tool-call count, and current turn identity are managed
by the turn store. Use `useTurnStore(selector)` in React components
and `useTurnStore.getState()` in non-React code (stream handlers,
reconciliation). Do not prop-drill turn state or dispatch functions.

Action naming follows the
[Flux-inspired practice](https://zustand.docs.pmnd.rs/learn/guides/flux-inspired-practice):
`on*` for SSE-event reactions (`onTextDelta`, `onStreamError`,
`onPollReconciled`), imperative for user/system-initiated actions
(`requestSend`, `cancelGeneration`, `resetTurn`).

### Selector patterns and `useShallow`

Selectors control re-render granularity. Choose the right pattern based
on what the selector returns:

```ts
// 1. Primitive selector — no useShallow needed
const assistantId = useChatStore((s) => s.assistantId);

// 2. Object/array slice — useShallow required (new reference each call)
const { messages, assistantId } = useChatStore(
  useShallow((s) => ({ messages: s.messages, assistantId: s.assistantId })),
);

// 3. Derived/transformed state — useShallow doesn't help, use useMemo
const unread = useChatStore((s) => s.messages.filter((m) => !m.read));
// ⚠️ returns new array each time — wrap consumer in useMemo or use
// a custom equality function via createWithEqualityFn.
```

Rule of thumb: if the selector returns a **primitive** (`string`,
`number`, `boolean`, `null`), use it directly. If it returns a **new
object or array**, wrap with `useShallow`. If it **derives/transforms**
data, consider `useMemo` in the consumer or a stable selector defined
outside the component.

References:
- [Zustand — Prevent rerenders with useShallow](https://zustand.docs.pmnd.rs/guides/prevent-rerenders-with-use-shallow)
- [Zustand v5 selector best practices (community discussion)](https://github.com/pmndrs/zustand/discussions/2867)

### Auto-generated selectors via `createSelectors`

Wrap every store with `createSelectors()` from `src/utils/create-selectors.ts`
to auto-generate per-field selector hooks. This is the
[official Zustand pattern](https://zustand.docs.pmnd.rs/learn/guides/auto-generating-selectors)
for reducing boilerplate while keeping per-field re-render optimization.

```ts
import { create } from "zustand";
import { createSelectors } from "@/utils/create-selectors.js";

interface BearState {
  bears: number;
  increase: (by: number) => void;
}

const useBearStoreBase = create<BearState>()((set) => ({
  bears: 0,
  increase: (by) => set((state) => ({ bears: state.bears + by })),
}));

export const useBearStore = createSelectors(useBearStoreBase);
```

Consumers use the `.use` property — fully typed, with autocomplete:

```ts
// Auto-generated selector — one field, minimal re-renders
const bears = useBearStore.use.bears();
const increase = useBearStore.use.increase();

// .getState() still works for non-React contexts (middleware, interceptors)
const { bears } = useBearStore.getState();
```

Prefer `.use.field()` over manual `(s) => s.field` selectors. For
derived/computed values (e.g. `user?.id`), use `.use.user()` and
access the property from the result. See
[Reading state: `.use.*` vs `.getState()`](#reading-state-use-vs-getstate)
for when to use each API.

Reference: [Zustand — Auto Generating Selectors](https://zustand.docs.pmnd.rs/learn/guides/auto-generating-selectors)

### Reading state: `.use.*` vs `.getState()`

Zustand exposes two ways to read store state. Using the wrong one
causes either missed re-renders or unnecessary subscriptions.

| Context | API | Why |
|---------|-----|-----|
| **React render body** (component/hook top level) | `useStore.use.field()` | Creates a subscription — component re-renders when `field` changes. Required for reactive UI. |
| **Event handlers, callbacks, effects, `useCallback` bodies** | `useStore.getState().field` | Reads the latest value at call time without creating a subscription. No stale-closure risk. |
| **Outside React** (middleware, interceptors, stream handlers, `main.tsx`) | `useStore.getState().field` | No React context available — `.use.*` would throw. |
| **Calling actions** (anywhere) | `useStore.getState().actionName()` | Actions are stable references — calling via `.getState()` is always correct and avoids adding the action to dependency arrays. |

```ts
// Render body — reactive subscription
const count = useMessageStore.use.count();

// Event handler — imperative read + action
const handleClick = useCallback(() => {
  useMessageStore.getState().increment();
}, []);

// Middleware — outside React
const { isLoggedIn } = useAuthStore.getState();
```

Zustand's `set()` is synchronous — `.getState()` after an action
returns already-mutated values. Read state *before* calling an action
when the caller needs pre-mutation values.

References:
- [Zustand — Updating state](https://zustand.docs.pmnd.rs/guides/updating-state)
- [Zustand — Reading/writing state outside components](https://zustand.docs.pmnd.rs/guides/extracting-state-outside-components)
- [React — Rules of Hooks](https://react.dev/reference/rules/rules-of-hooks)

### Data fetching: React Query vs direct SDK calls

Use **React Query** for data consumed primarily by React components —
it provides stale-while-revalidate, automatic background refetching,
cache sharing between components, and error/loading states. This covers
most API data: chat messages, assistant state, billing, settings, etc.

Use **direct SDK calls** inside Zustand stores for infrastructure-level
shared state that must be readable outside the React tree (middleware,
API interceptors, loaders) via `.getState()`. This applies when:

1. **Non-React consumers exist** — middleware or interceptors need the
   data synchronously before any component renders.
2. **The fetch is simple** — a single call on login or on demand,
   with no benefit from background refetching or cache sharing.
3. **The store is the single source of truth** — no need to sync
   between React Query cache and a separate module-level variable.

Auth and organization state both fit this category. The generated SDK
client (`sdk.gen.ts`) exposes the same typed API functions that React
Query wraps, so switching from `useQuery(optionsFn())` to a direct
`apiFunction()` call uses the same endpoint, types, and interceptors.

```ts
// Infrastructure store — direct SDK call
import { organizationsList } from "@/generated/api/sdk.gen.js";

const useOrgStoreBase = create<OrgStore>()((set) => ({
  organizations: [],
  fetchOrganizations: async () => {
    const result = await organizationsList();
    set({ organizations: result.data?.results ?? [] });
  },
}));

// Domain data — React Query (used only in components)
const { data } = useQuery(assistantsListOptions());
```

References:
- [TkDodo — Working with Zustand](https://tkdodo.eu/blog/working-with-zustand) — React Query maintainer's guidance on the boundary between server state (RQ) and client/infrastructure state (Zustand)
- [Zustand — Reading/writing state outside components](https://zustand.docs.pmnd.rs/guides/reading-and-writing-state-outside-components)

### useReducer for component-local state only

When two or more pieces of **component-local** state change together
or have interdependent transitions, consolidate them into a
`useReducer` with typed action events. Reserve `useState` for
independent, single-value state (a boolean toggle, a text input
value).

**Do not use `useReducer` for state shared across components.** Shared
state belongs in a Zustand store with direct named actions (see
[Direct named actions, not reducers](#direct-named-actions-not-reducers)).

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

### Direct named actions, not reducers

Zustand's recommended pattern is **direct named actions** — plain
functions on the store that call `set()`. Do not use dispatchers,
action-type strings, or switch-case reducers. The `redux` middleware
exists for Redux migration paths but is not the idiomatic Zustand
approach.

```ts
// Good — Zustand-idiomatic direct actions
export const useTurnStore = create<TurnStore>()((set, get) => ({
  phase: "idle" as TurnPhase,
  activeTurnId: null as string | null,
  activeToolCallCount: 0,

  startTurn: (turnId: string) =>
    set({ phase: "thinking", activeTurnId: turnId }),

  startStreaming: () =>
    set({ phase: "streaming" }),

  completeTurn: () =>
    set({ phase: "idle", activeTurnId: null, activeToolCallCount: 0 }),

  incrementToolCalls: () =>
    set((s) => ({ activeToolCallCount: s.activeToolCallCount + 1 })),
}));

// Avoid — reducer/dispatch pattern (Redux holdover)
dispatch: (action) => set((state) => turnReducer(state, action))
```

Each action is independently callable, testable, and discoverable via
the store's TypeScript interface. Consumers call
`useTurnStore.getState().startTurn(id)` or select individual actions
via hooks — no action-type constants or switch statements needed.

References:
- [Zustand — Flux-inspired practice](https://zustand.docs.pmnd.rs/learn/guides/flux-inspired-practice) — "state can be updated without dispatched actions and reducers"
- [Zustand — Updating state](https://zustand.docs.pmnd.rs/learn/guides/updating-state)

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

### Route protection via middleware

Protected routes use React Router v7
[middleware](https://reactrouter.com/how-to/middleware) (enabled via the
`v8_middleware`
[future flag](https://reactrouter.com/upgrading/future#futurev8_middleware)).
Middleware runs **before** the route component renders — no flash of
protected content, no `useEffect`-based redirects.

```ts
createBrowserRouter([
  // Public — no middleware
  { path: "/account/login", Component: LoginPage },

  // Protected — auth middleware gates access
  {
    path: "/assistant",
    middleware: [authMiddleware],
    Component: RootLayout,
    children: [/* ... */],
  },
], {
  future: { v8_middleware: true },
});
```

The auth middleware reads from the Zustand auth store (via
`.getState()` — no hook needed) and throws `redirect("/account/login")`
when unauthenticated. User data is passed downstream via React Router's
typed
[`context`](https://reactrouter.com/start/data/route-object/#middleware),
accessible in loaders and components.

Authentication is always required. The middleware reads from the Zustand
auth store and redirects unauthenticated users to `/account/login`.

### URL-driven routing

The app uses React Router v7 nested routes. Each view maps to a route;
the URL is the source of truth. Custom in-memory navigation state
(e.g. `MainView` enums synced to URLs via effects) should be replaced
by routes as views are ported.

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

### Injecting app-specific behavior

Design library components expose callback or component props for
customization (e.g. `linkComponent` on `MarkdownMessage`). Consumers
pass domain-specific implementations via these props — this is the
standard pattern used by
[react-markdown](https://github.com/remarkjs/react-markdown#components),
[MUI](https://mui.com/material-ui/integrations/routing/), and
[Radix](https://www.radix-ui.com/docs/primitives/guides/composition).

When many call sites pass the same prop, a **domain convenience wrapper**
is acceptable — but it must:

- Have a **distinct name** that signals what it adds (e.g.
  `ChatMarkdownMessage`, not `MarkdownMessage`)
- Live in the **domain directory** that owns the behavior (e.g.
  `domains/chat/components/`), not in the cross-domain `components/`
  directory
- Never shadow the design library export name

The design library component must always remain directly importable for
contexts that don't need the domain behavior (e.g. auth-free local
usage).

```ts
// Domain wrapper — lives in domains/chat/components/chat-markdown-message.tsx
import { MarkdownMessage } from "@vellum/design-library";

// OAuthAwareLink defined in the same file (or extracted to a lib file)
export function ChatMarkdownMessage(props: ChatMarkdownMessageProps) {
  return <MarkdownMessage {...props} linkComponent={OAuthAwareLink} />;
}
```

For component authoring conventions (React 19 ref-as-prop, `data-slot`,
variant patterns, file organization), see
[`packages/design-library/README.md`](../../packages/design-library/README.md).

References:
- [Node.js — Package exports](https://nodejs.org/api/packages.html#exports)
- [Bun — Workspaces](https://bun.sh/docs/install/workspaces)
- [React — Passing Props to a Component](https://react.dev/learn/passing-props-to-a-component)
- [react-markdown — components prop](https://github.com/remarkjs/react-markdown#components)

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
[HeyAPI (`@hey-api/openapi-ts`)](https://heyapi.dev/). The public-facing
specs (`openapi-schemas/platform.yaml`, `openapi-schemas/auth.yaml`) are
committed to this repo so anyone can regenerate the client locally:

```bash
bun run openapi-ts
```

Generated output lives in `src/generated/api/` (gitignored).

**Vellum developers** updating the specs after platform API changes:

```bash
./scripts/sync-openapi-specs.sh   # copies from sibling platform checkout
bun run openapi-ts                # regenerate client
```

Plugins (configured in `openapi-ts.config.ts`):
- `@hey-api/client-fetch` — Fetch-based HTTP client, bundled inline
  in the generated output ([no runtime dep needed](https://github.com/hey-api/openapi-ts/pull/790))
- `@tanstack/react-query` — generates `*Options()` helpers for
  `useQuery` / `useMutation` / `useInfiniteQuery`
- `@hey-api/typescript` — generates TypeScript types from schemas
  (included by default, does not need explicit config)

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
- **Test Zustand stores via their non-React API.** Use `.getState()`
  and `.setState()` directly — no React rendering needed. Reset the
  store in `beforeEach` with `useStore.setState(initialState, true)`
  (the `true` flag replaces the entire state instead of merging).

  Reference: [Zustand — Testing](https://zustand.docs.pmnd.rs/guides/testing)

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
