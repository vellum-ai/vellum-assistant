# Web App — Frontend Conventions

Architectural decisions, patterns, and rationale for the Vellum web app.
Covers code organization, state management, component design, and
framework strategy. For coding style, naming, and import rules see
[`STYLE_GUIDE.md`](./STYLE_GUIDE.md).

See also [`apps/web/AGENTS.md`](../AGENTS.md) for the quick-rules entry point, and broader patterns in [`apps/AGENTS.md`](../../AGENTS.md) / root [`AGENTS.md`](../../../AGENTS.md).

---

## Architecture overview

The web app is a **Vite + React Router v7 SPA** using
[library / data-router mode](https://reactrouter.com/start/modes)
(`createBrowserRouter` + `<RouterProvider>`). See
[`apps/web/README.md`](../README.md) for the full stack description and
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

### Layout header slots

`ChatLayout` owns a shared `ChatLayoutHeader` that renders on every
child route (home, chat, library, identity, etc.). Child routes
populate the header's center and right sections via
`setTopBarCenter` / `setTopBarRightSlot` from `useAssistantContext()`.
Register content in a `useEffect` and clear it on unmount:

```ts
const { setTopBarCenter } = useAssistantContext();
useEffect(() => {
  setTopBarCenter(<span>Page Title</span>);
  return () => { setTopBarCenter(null); };
}, [setTopBarCenter]);
```

Every child route under `ChatLayout` should register its title this
way. Without it the header center is empty, which is especially
noticeable on mobile where the sidebar is hidden.

References:
- [React — Thinking in React](https://react.dev/learn/thinking-in-react)
- [React Router — Layout Routes](https://reactrouter.com/start/framework/routing#layout-routes)

### Route-level code splitting

Routes use `Component` (not `element`) and the object-based `lazy`
property for code splitting. Vite creates a separate chunk per dynamic
`import()`, so each lazy route loads only when navigated to.

**Eager routes** (critical path — always in the initial bundle):
`RootLayout`, `ChatLayout`, `ChatPage`, `ConversationRedirect`,
`ActiveAssistantGate`, `NotFound`.

**Lazy routes** (everything else): settings, logs, account/auth,
onboarding, intelligence pages, library, inspector, home, connect,
documents. `DocumentViewerPage` is reached only from `LibraryPage`
(itself lazy), so its lazy chunk loads in parallel with code the user
has already paid the lazy cost on. Its big sub-tree
(`TiptapDocumentEditor`) is further `React.lazy`-split inside
`DocumentViewerContainer` so it doesn't reach the main bundle through
chat either.

```ts
// Lazy route — object syntax (preferred)
{ path: "settings", lazy: { Component: () => import("./settings-layout").then((m) => m.SettingsLayout) } }

// Eager route — direct Component reference
{ path: "conversations/:conversationId", Component: ChatPage }
```

When adding a new route, default to `lazy` unless it's on the primary
landing path. Use `Component`, not `element` — they are mutually
exclusive and `lazy` returns `Component`.

Errors during route resolution (loader exceptions, lazy chunk fetch
failures, render bugs) are caught by `RouteErrorBoundary`
(`src/components/route-error-boundary.tsx`), mounted at every level of
the route tree. It picks one of two UI variants based on the error
shape:

- **Lazy-chunk fetch failure** (stale deploy, network drop) — renders
  an inline "this section couldn't load" message with a Reload
  button. Mounted via pathless wrappers inside `/account`,
  `/assistant`, and `ChatLayout` so the parent chrome (sidebar, etc.)
  stays visible and the user can navigate elsewhere.
- **Anything else** — renders the full-page "Something went wrong"
  treatment.

`isChunkLoadError(err)` in `src/lib/chunk-errors.ts` is the single
predicate used by both the boundary and `LazyBoundary`
(component-level lazy in `src/components/lazy-boundary.tsx`). For
non-route lazy components (modals, inline lazy widgets) use
`LazyBoundary` directly.

`RouterProvider.onError` in `main.tsx` is the single Sentry capture
point for router errors — it tags each event with
`boundary: "lazy-route"` for chunk failures and
`boundary: "route-render"` for everything else, so the two are
sliceable in Sentry. Component-level `LazyBoundary` tags its captures
analogously (`"lazy-component"` / `"component-render"`).

References:
- [React Router — Route Object (`Component`)](https://reactrouter.com/start/data/route-object#component)
- [React Router — Lazy Loading (Data Mode)](https://reactrouter.com/start/data/custom#3-lazy-loading)
- [React Router — `lazy` property](https://reactrouter.com/start/data/route-object#lazy)

---

## Code organization

### Organize by domain, not technical layer

Group code by what it does (messages, conversations, streaming,
interactions), not by what it is (hooks, utils, components). The
top-level folder for domain modules is called **`domains/`**.

```
src/
  assistant/                       # core domain — the assistant itself
    api.ts                         #   identity, state, version, settings
    lifecycle.ts                   #   hatch / retire / restart
    types.ts                       #   shared assistant types
  stores/                          # app-level Zustand stores (cross-domain)
    viewer-store.ts
    sse-connected-store.ts
    conversation-store.ts
  domains/                         # feature modules
    messages/                      # message lifecycle
      message-store.ts
      use-send-message.ts
      message-handlers.ts
      message-handlers.test.ts
      types.ts
      components/
        chat-body.tsx
    conversations/                 # conversation CRUD, grouping, selection
      conversation-queries.ts
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
    chat/                          # chat feature module
      turn-store.ts                #   turn-level state machine
      turn-coordinator.ts          #   atomic turn-store + conversation-store transitions
      turn-selectors.ts            #   render-decision selectors from TurnState
  hooks/                           # cross-domain shared hooks
    use-is-mobile.ts
    use-visible-viewport.ts
  utils/                           # cross-domain shared utilities
    format.ts
    browser.ts
  types/                           # cross-domain shared types
    window.d.ts
  lib/                             # third-party integrations & infrastructure
    sentry/                        #   Sentry error reporting (init, consent control)
    auth/                          #   allauth client, CSRF, auth middleware
    feature-flags/                 #   feature flag provider
    sync/                          #   server state sync (tag registry, router)
    api-client.ts                  #   HeyAPI configured client + interceptors
    telemetry/                     #   client identity for daemon registration
  runtime/                         # framework adapters, platform bridges
    native-auth.ts
    route-adapter.ts
  components/                      # cross-domain shared UI
```

#### Why `domains/` not `features/`

This app uses `domains/` over the more common `features/` because
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

Reference: [Bulletproof React — Project Structure](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md) describes the same separation between `features/` and `app/routes/`.

### How to decide where the domain split is

Think of domains like database tables, not nested documents. Split by
**lifecycle and reason-to-change**, not by containment:

- **Separate domain if:** it has its own API endpoints, its own data
  model/types, its own state lifecycle, and could be worked on by a
  different developer without merge conflicts.
- **Same domain if:** two things always change together, share the same
  store, and splitting them would create circular cross-imports.
- **No cross-domain imports.** Each folder under `src/domains/`
  is meant to be a self-contained feature area — its own data,
  components, hooks, and tests. When one feature reaches directly
  into another's internals, you create a hidden coupling:
  changing the source feature can break the consumer even though
  they're supposed to be independent. Over time those reaches
  accumulate into a tangle that's hard to reason about and harder
  to refactor.

  So the rule is:

  - Code used by **one** feature lives inside that feature.
  - Code used by **two or more** features moves up to a top-level
    shared directory (`hooks/`, `stores/`, `utils/`, `types/`,
    `components/`) — see
    [Top-level shared directories](#top-level-shared-directories).
  - Two features that need to interact compose at the
    page/route level rather than importing each other directly.
  - Code that's central to the whole app (the assistant itself)
    sits at the top level, where every feature can depend on it
    but it depends on no feature.

  This keeps each feature folder a coherent unit you can read,
  work on, or delete without surprises elsewhere, and makes
  ownership obvious: if it's inside `chat/`, it belongs to chat;
  if it's at the top level, it's shared infrastructure.

  **Enforced by ESLint.** The custom rule
  [`local/no-cross-domain-imports`](../eslint-rules/no-cross-domain-imports.mjs)
  fails CI on any new `from "@/domains/<y>/..."` inside a file
  under `apps/web/src/domains/<x>/...` when `x !== y`. Existing
  legacy imports are listed in
  [`.cross-domain-allowlist.json`](../.cross-domain-allowlist.json)
  while we lift shared code up to the top level. That file
  shrinks toward zero over time — don't add new entries by hand;
  fix the violation instead. After removing one, regenerate the
  snapshot:

  ```sh
  bun run audit:cross-domain
  ```

- **No circular dependencies.** If A imports from B AND B imports
  from A, either merge them or hoist the shared code to a
  top-level directory.

For further reading, [bulletproof-react's project structure
docs](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md#cross-feature-access)
describe a similar one-feature/multi-feature rule that this
codebase's convention is in the same spirit as.

Examples of correct splits:
- `messages/` vs `conversations/`: messages are created, streamed,
  delta-updated, and compacted — different lifecycle from conversation
  CRUD and grouping.
- `streaming/` vs `messages/`: SSE transport and reconnection logic
  changes for different reasons than message state management.
- `interactions/` vs `turn/`: user-facing prompts (secrets,
  confirmations) have their own state machine, independent from the
  turn lifecycle (idle → sending → receiving → complete).

### Conversation identifiers: `conversationId` vs `conversationKey`

The daemon uses two identifiers for conversations:

| Identifier | Format | Source table | Example |
|---|---|---|---|
| `conversationId` | UUID | `conversations` (all DB versions) | `a1b2c3d4-e5f6-...` |
| `conversationKey` | Arbitrary string | `conversation_keys` (migration 101+) | `default:slack:C0123` |

For **web-originated** conversations, the key happens to equal the UUID —
but that is an implementation coincidence, not a contract. Channel-bound
conversations (Slack, email, Telegram) have keys like
`default:slack:C0123` that differ from their UUID.

**Rules:**

1. **API queries from web must send `conversationId` (the UUID), never
   `conversationKey`.** Assistant 0.8.5+ accepts `conversationId` on
   `POST /v1/messages` and `GET /v1/events` and looks it up directly
   against the `conversations` table. The version gate that picks
   between `conversationId` (>= 0.8.5) and the legacy `conversationKey`
   (< 0.8.5) lives in
   [`lib/backwards-compat/conversation-id-wire-field.ts`](../src/lib/backwards-compat/conversation-id-wire-field.ts).
   The legacy `conversationKey` path is supported indefinitely for
   non-vellum channel adapters (Telegram, WhatsApp, etc.), but web
   code never uses it.

   ```ts
   // Correct
   query: { conversationId }
   ```

2. **URL route params carry UUIDs.** The route param is currently named
   `:conversationKey` for historical reasons but the value must be a
   UUID. Never put a channel-scoped key (e.g. `default:slack:C0123`)
   in the URL.

3. **When the codebase says `conversationKey`, read it as "the
   identifier we route by" — which for web is always a UUID.** The
   `conversationKey` field is retained in the assistant's wire schema
   for external channel adapters; web-originated traffic uses
   `conversationId`.

### Top-level shared directories

Code used across multiple domains lives in top-level shared
directories. If something is domain-specific, it belongs inside
`domains/<name>/`.

**Decision rule for hooks/stores/utils:**

1. Used by exactly one domain → live inside that domain
   (`domains/<x>/hooks/`, `domains/<x>/<x>-store.ts`, etc.).
2. Used by two or more domains → lift to the top-level shared dir
   (`hooks/`, `stores/`, `utils/`). Cross-domain imports between
   `domains/` peers are a smell.
3. Foundational/cross-cutting concerns with no single domain owner
   (auth, viewer identity, SSE connectivity, feature flags) → always
   top-level, even if currently consumed by one domain.

Example: `useAssistantIdentityInit` and `assistant-identity-store`
live at `hooks/` and `stores/` because the assistant identity is
consumed by chat, intelligence, library, contacts — no single domain
owns it.

| Folder | Purpose | Example contents |
|---|---|---|
| `assistant/` | Core business-domain code for the assistant itself — the central concept every feature composes around. Every domain may depend on it; it depends on no domain. New top-level business-concept folders require explicit team approval. | `api.ts`, `lifecycle.ts`, `types.ts`, `llm-model-catalog.ts` |
| `stores/` | App-level Zustand stores (cross-domain state) | `viewer-store.ts`, `sse-connected-store.ts`, `assistant-feature-flag-store.ts` |
| `hooks/` | Cross-domain React hooks | `use-is-mobile.ts`, `use-visible-viewport.ts`, `use-feature-flag-bus-sync.ts` |
| `utils/` | Pure utility functions (no side effects, no third-party SDKs) | `format.ts`, `browser.ts`, `network-status.ts`, `stable-id.ts` |
| `types/` | Shared type definitions | `window.d.ts`, `api-types.ts` |
| `lib/` | Third-party integrations and infrastructure wrappers (have side effects, configure SDK instances, manage lifecycle) | `sentry/` (error reporting), `auth/` (allauth + CSRF), `feature-flags/` (catalog + registry), `sync/` (state sync), `api-client.ts` (HeyAPI) |
| `runtime/` | Framework adapters and native platform bridges | `route-adapter.ts`, `native-auth.ts`, `native-deep-link.ts`, `app-bridge.ts` |
| `components/` | Cross-domain shared UI | `error-boundary.tsx`, `sign-in-gate.tsx`, `providers.tsx` |

| `generated/` | Auto-generated code (HeyAPI, catalogs) | `api/`, `catalogs/` |

#### `lib/` vs `utils/` — where does my code go?

| | `lib/` | `utils/` |
|---|---|---|
| **Purpose** | Third-party SDK integrations, infrastructure wrappers, code with initialization or lifecycle | Pure helper functions with no side effects |
| **Side effects?** | Yes — initializes SDKs, configures interceptors, manages consent/lifecycle | No — pure input→output, no global state, no I/O |
| **Third-party SDK dependency?** | Yes — wraps `@sentry/react`, `@heyapi/client-fetch`, etc. | No — only standard library / language utilities |
| **Subdirectories?** | Yes — each integration gets its own directory (e.g. `lib/sentry/`, `lib/auth/`, `lib/sync/`) | Flat — individual utility files at the top level |
| **Examples** | `lib/sentry/sentry-init.ts`, `lib/auth/allauth-client.ts`, `lib/api-client.ts` | `utils/format.ts`, `utils/browser.ts`, `utils/cn.ts` |

If the code configures an SDK instance, runs at startup, or manages a
third-party service lifecycle, it belongs in `lib/`. If it's a pure
function you could copy-paste into any project without installing a
dependency, it belongs in `utils/`.

Reference: [Bulletproof React — `lib/` directory](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md)

#### `lib/` vs `runtime/`

Both contain infrastructure code, but they serve different purposes:

- **`lib/`** — wraps *external* third-party services and SDKs (Sentry, HeyAPI, allauth). These are vendor integrations the app consumes.
- **`runtime/`** — adapts the app to its *host environment* (Capacitor native bridges, route adapters, platform detection). These handle differences between web, iOS, and macOS without third-party SDK dependencies.

If the code imports a third-party SDK and configures it → `lib/`. If it bridges between the app and the native platform or framework runtime → `runtime/`.

### No barrel files

Do not use barrel files (`index.ts` that re-export siblings). Import
from the source file directly. If you believe this rule should change,
open a GitHub issue to discuss.

### No single-file directories

A directory that contains exactly one file should be flattened — move
the file up one level and remove the empty directory. Directories
exist to organize multiple files, not to wrap a single file.

When flattening, verify the file lands in the **correct parent**
directory, not just one level up. For example, a Zustand store nested
in `domains/settings/stores/theme-store.ts` should move to the
domain root (`domains/settings/theme-store.ts`) or to top-level
`stores/` if it's cross-domain — not just flatten in place if the
parent directory is wrong.

---

## State management

State management has its own document: see
[`STATE_MANAGEMENT.md`](./STATE_MANAGEMENT.md).

Quick summary:

- **Client state** lives in Zustand stores with direct named actions and atomic selectors via `createSelectors`.
- **Server state** lives in TanStack Query.
- **`useReducer` is not used** for client state, even within a single hook. See [STATE_MANAGEMENT.md — useReducer is not used](./STATE_MANAGEMENT.md#usereducer-is-not-used-for-client-state).
- **`useShallow`** is not introduced in new code — atomic selectors avoid the need.

## Event bus

Cross-domain push signals (SSE, app lifecycle, network reachability)
flow through a single event bus. See
[`EVENT_BUS.md`](./EVENT_BUS.md).

Quick summary:

- **One SSE connection per tab.** Only `useEventBusInit` calls `subscribeChatEvents`; every other consumer subscribes to `bus.sse.event`.
- **No per-component `visibilitychange` listeners** for data-refresh. Subscribe to `bus.app.resume` / `bus.app.hidden` instead.
- **No `window.online` / `window.offline` listeners** in components or stores. Subscribe to `bus.app.online` / `bus.app.offline`.
- **No polling** for state the daemon could push. Emit a typed event over `/v1/events` and subscribe via the bus.


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
[`packages/design-library/README.md`](../../../packages/design-library/README.md).

References:
- [Node.js — Package exports](https://nodejs.org/api/packages.html#exports)
- [Bun — Workspaces](https://bun.sh/docs/install/workspaces)
- [React — Passing Props to a Component](https://react.dev/learn/passing-props-to-a-component)
- [react-markdown — components prop](https://github.com/remarkjs/react-markdown#components)

---

## API client codegen

Server state, React Query usage, and the Zustand-vs-Query boundary are
covered in [`STATE_MANAGEMENT.md`](./STATE_MANAGEMENT.md). This section
is about the **tooling** that produces the API client itself: OpenAPI
codegen, generated hooks, and when to bypass them.

### HeyAPI for OpenAPI client generation

The API client is generated from the platform's OpenAPI spec using
[HeyAPI (`@hey-api/openapi-ts`)](https://heyapi.dev/). The public-facing
specs (`openapi-schemas/platform.yaml`, `openapi-schemas/auth.yaml`) are
committed to this repo so anyone can regenerate the client locally:

```bash
bun run openapi-ts
```

Generated output lives in `src/generated/api/` (gitignored). Codegen runs
automatically via [npm lifecycle hooks](https://docs.npmjs.com/cli/v10/using-npm/scripts#life-cycle-scripts):

- **`postinstall`** — runs after every `bun install`; generates the client
  when `src/generated/` doesn't exist yet (first-time bootstrap).
- **`predev`** — runs before every `bun run dev`; always regenerates so
  the client stays in sync with the committed specs.

No manual codegen step is needed — `bun install` + `bun run dev` triggers
these hooks automatically. Vellum maintainers using the internal `vel`
CLI also get codegen via `vel up --vite`.

**Vellum maintainers** updating the specs after backend API changes:

```bash
./scripts/sync-openapi-specs.sh   # copies from sibling platform checkout
bun run dev                       # predev regenerates automatically
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

## Authentication

The SPA is converging on a single auth design: gateway-issued
HttpOnly session cookies, applied uniformly across browser, Capacitor
iOS, and Electron. Until that lands, follow these conventions to keep
the codebase convergent rather than divergent.

### One HeyAPI client instance

There is exactly one HeyAPI client per app, exported by
`@/generated/api/client.gen.js`. Hand-written wrappers and call sites
must import that singleton — they must **not** call `createClient(...)`
themselves.

This is enforced by an ESLint rule
(`no-restricted-syntax`/`CallExpression[callee.name='createClient']`).
A second `createClient(...)` instance does not inherit the request
interceptors that attach the auth headers, so every request through it
silently ships unauthenticated. Upstream rejects the request; the
wrapper returns `null`; the UI degrades to a fallback. The class of bug
is hard to notice in code review because the second-instance code looks
correct in isolation. Don't add a second instance.

### Auth-related headers stay inside the auth boundary

The headers `Vellum-Organization-Id`, `X-CSRFToken`, and `X-Session-Token`
only appear inside `src/lib/auth/` and `src/lib/api-interceptors.ts`.
Everywhere else, an ESLint rule (`no-restricted-syntax` literal
selectors) flags string-literal uses of those header names.

If you find yourself wanting to set one of those headers in app code,
the answer is to use the central interceptor (already installed on the
singleton client). If you're writing raw `fetch()` for a streaming
endpoint, use the helpers in `src/lib/auth/request-headers.ts` — but
do not extend those helpers; the file is transitional and slated for
deletion.

### No JS-readable storage for tokens or credentials

Do not write anything token-, credential-, secret-, JWT-, bearer-,
password-, or api-key-shaped to `localStorage` or `sessionStorage`.
JS-readable storage is XSS-exposed; an injected script can exfiltrate
the entire store. An ESLint rule blocks `setItem` calls whose key
literal matches that pattern.

The right storage:

- **Web / Capacitor iOS:** the HttpOnly session cookie issued by the
  gateway, set automatically by the browser. The SPA never touches it.
- **Electron:** the same HttpOnly cookie via Electron's session
  partition. For anything that genuinely needs client-managed storage,
  `Electron.safeStorage` (Keychain on macOS, libsecret on Linux,
  DPAPI on Windows).
- **Capacitor iOS biometric persistence:** Keychain via the existing
  `native-biometric` plugin (only for opt-in "remember me" persistence;
  not the primary token store).

### No new `X-Session-Token` users

`X-Session-Token` is a legacy native-bridge artifact from the iOS
plugin (it forwards a server-side session ID across the JS↔Swift
boundary). It is being retired once the gateway issues cookies that
the WKWebView populates directly. New code that mentions this header
is a lint error.

### Native-platform branching belongs in `lib/auth/`

If you need to write `if (isNativePlatform)` in auth-touching code,
leave a `TODO` next to it pointing at the planned consolidation. The
end state has a single native bridge interface (Capacitor today,
Electron next) so app code shouldn't be branching on which shell is
wrapping the SPA.

---

## Testing

- **Test framework:** [Bun's test runner](https://bun.sh/docs/test)
  (`describe`, `it`, `expect`, `mock`).
- **DOM environment:**
  [happy-dom](https://github.com/nicedoc/happy-dom) provides
  `window`, `document`, `localStorage`, `sessionStorage`, and `fetch`
  via a preload script (`test-setup.ts`, referenced in `bunfig.toml`).
  Component and hook tests can render to the DOM without a real
  browser.
- **Component rendering:** Use
  [`@testing-library/react`](https://testing-library.com/docs/react-testing-library/intro/)
  `render` for component tests.
  [`renderToStaticMarkup`](https://react.dev/reference/react-dom/server/renderToStaticMarkup)
  is SSR-only and does not support Zustand store subscriptions — avoid
  it for tests that rely on store state.
- **Colocate tests with source.** `message-handlers.test.ts` lives
  alongside `message-handlers.ts`.
- **Test reducers and pure functions in isolation.** They are pure
  functions — unit-test state transitions directly before relying on
  integration tests.
- **Mock at the right boundary.** Mock API clients (`client.get`,
  `client.post`), not `globalThis.fetch`. This catches request-building
  bugs that fetch-level mocks miss.
- **`mock.module()` is process-global.** Bun's
  [`mock.module()`](https://bun.sh/docs/test/mocking#mock-module)
  replaces the module for the entire process — mocks leak across test
  files. Files pass individually but may fail in a full `bun test` run.
  CI uses `bun run test:ci` (each file in its own subprocess) to
  guarantee isolation.
- **Run tests:**
  ```bash
  bun test src/path/to/file.test.ts  # single file (fast)
  bun run test:ci                    # all files, isolated (CI)
  ```
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
