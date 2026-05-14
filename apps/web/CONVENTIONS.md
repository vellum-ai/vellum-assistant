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

### Route-driven component boundaries

Each route should only mount the hooks and state it actually needs.
Avoid "god components" that render on every route with conditional logic
to hide irrelevant sections.

```
routes.tsx
  <App />            ← shared shell (nav, layout, providers)
    <Outlet />
      <ConversationNew />     ← only mounts conversation-creation hooks
      <ConversationDetail />  ← mounts streaming, messages, interactions
      <SettingsTab />         ← mounts settings-specific state
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
interactions), not by what it is (hooks, utils, components).

```
src/
  features/
    messages/
      use-send-message.ts
      message-handlers.ts
      message-handlers.test.ts
      types.ts
    conversations/
      use-conversation-loader.ts
      conversation-reducer.ts
      conversation-reducer.test.ts
    streaming/
      stream-handlers/
        message-handlers.ts
        interaction-handlers.ts
        types.ts
      use-stream-event-handler.ts
    interactions/
      interaction-state-machine.ts
      interaction-state-machine.test.ts
      use-interaction-actions.ts
```

Prefer domain folders over technical-layer folders (`hooks/`, `utils/`,
`types/`). **Cross-domain shared code lives at the nearest common
ancestor.** If a utility or hook is consumed by multiple domains, hoist
it — sometimes that means a top-level shared directory, and that's
fine.

Reference: [React Router — Feature Folders](https://reactrouter.com/how-to/file-route-conventions)

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

## Data fetching

### React Query for server state

Use [TanStack React Query](https://tanstack.com/query/latest) for
server-derived data. When multiple components need the same data, use a
shared hook with a stable query key — not independent `useState` +
`useEffect` fetch cycles in each consumer.

Reference: [React Query — Query Invalidation](https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation)

### Generated API clients

For backend API routes, prefer generated clients (e.g. HeyAPI
`*Options()` helpers with `useQuery` / `useMutation`) over hand-written
`fetch` wrappers. Do not create new direct `fetch()` calls with
hardcoded backend prefixes unless the generated client cannot support the
use case (e.g. SSE/streaming). If bypassing, add a comment explaining
why.

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
