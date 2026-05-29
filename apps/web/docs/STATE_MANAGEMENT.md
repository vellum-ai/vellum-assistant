# Web App — State Management

How client state and server state are managed in `apps/web/`. Zustand
stores for client state, TanStack Query for server state, atomic
selectors, no `useReducer`.

See also [`apps/web/AGENTS.md`](../AGENTS.md) and the umbrella
[`CONVENTIONS.md`](./CONVENTIONS.md).

---



## Zustand for shared mutable state

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
const phase = useTurnStore((s) => s.phase);

// Avoid — every consumer re-renders on any context change
const { phase } = useContext(TurnContext);
```

References:
- [Zustand docs](https://zustand.docs.pmnd.rs/)
- [Zustand — Auto-generating selectors](https://zustand.docs.pmnd.rs/guides/auto-generating-selectors)

## Zustand store conventions

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

import { createSelectors } from "@/utils/create-selectors";
import type { Message } from "./types";

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

## Selector patterns

**New code uses atomic selectors via `createSelectors`** — see the next
section ([Auto-generated selectors via `createSelectors`](#auto-generated-selectors-via-createselectors)).
Atomic selectors per field handle the re-render-granularity problem
without any of the `useShallow` ceremony described below.

### Legacy: `useShallow` patterns (for migration reference)

A small number of pre-`createSelectors` call sites still use these
patterns. They're documented here for historical context and to help
migrate them — new code uses atomic selectors instead.

```ts
// 1. Primitive selector — works without useShallow
const phase = useTurnStore((s) => s.phase);

// 2. Object/array slice — required useShallow to suppress the
//    new-reference-per-render re-render storm.
//    Replace in new code with two atomic selectors side-by-side.
const { phase, statusText } = useTurnStore(
  useShallow((s) => ({ phase: s.phase, statusText: s.statusText })),
);

// 3. Derived/transformed state — useShallow doesn't help.
//    Replace in new code with an atomic selector + useMemo in the consumer.
const isActive = useTurnStore((s) => s.phase !== "idle");
```

References:
- [Zustand — Prevent rerenders with useShallow](https://zustand.docs.pmnd.rs/guides/prevent-rerenders-with-use-shallow) (reference for legacy call sites)
- [Zustand — Auto Generating Selectors](https://zustand.docs.pmnd.rs/guides/auto-generating-selectors) (the recommended pattern)

## Auto-generated selectors via `createSelectors`

Wrap every store with `createSelectors()` from `src/utils/create-selectors.ts`
to auto-generate per-field selector hooks. This is the
[official Zustand pattern](https://zustand.docs.pmnd.rs/learn/guides/auto-generating-selectors)
for reducing boilerplate while keeping per-field re-render optimization.

```ts
import { create } from "zustand";
import { createSelectors } from "@/utils/create-selectors";

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

## Reading state: `.use.*` vs `.getState()`

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

## Data fetching: React Query vs direct SDK calls

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
import { organizationsList } from "@/generated/api/sdk.gen";

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

### Why React Query (not SWR or others)

- [HeyAPI `@tanstack/react-query` plugin](https://heyapi.dev/openapi-ts/plugins/tanstack-query) auto-generates type-safe query/mutation/infinite-query hooks from the OpenAPI spec. No equivalent plugin exists for SWR (still in proposal stage) or other libraries — this alone is decisive given our HeyAPI codegen pipeline.
- First-class mutation support, optimistic updates, and Redux-DevTools-style query inspection.
- 12M+ weekly downloads (2026), the most feature-complete option in the React server-state space.
- Boundary with Zustand is documented explicitly — see the section above. React Query handles server state; Zustand handles client state; they do not overlap.

References:
- [React Query — Overview](https://tanstack.com/query/latest/docs/framework/react/overview)
- [React Query — Comparison](https://tanstack.com/query/latest/docs/framework/react/comparison)
- [TkDodo — Working with Zustand](https://tkdodo.eu/blog/working-with-zustand) — React Query maintainer's guidance on the boundary between server state (RQ) and client/infrastructure state (Zustand)
- [Zustand — Reading/writing state outside components](https://zustand.docs.pmnd.rs/guides/reading-and-writing-state-outside-components)

## TanStack Query migration checklist

Migrating an existing imperative `setTimeout`-driven fetch loop to
TanStack Query forces explicit reasoning about cache events, retry
timing, and stale-time semantics that the original code typically
hid by coincidence. The patterns below are the ones we'd otherwise
re-discover in PR review.

### Mutation refs

[`useMutation()`](https://tanstack.com/query/latest/docs/framework/react/reference/useMutation)
returns a new object reference on every render. Including the
mutation object in a `useCallback`/`useMemo` dependency array makes
that callback identity-unstable. Effects that depend on the callback
re-fire on every render, which for a lifecycle hook can become a
continuous fetch loop.

Capture `mutateAsync` in a ref instead:

```ts
const fooMutation = useMutation({ mutationFn: foo });
const fooMutateRef = useRef(fooMutation.mutateAsync);
fooMutateRef.current = fooMutation.mutateAsync;

const doSomething = useCallback(async () => {
  await fooMutateRef.current(args); // not fooMutation.mutateAsync
}, []); // mutation NOT in deps
```

The bound `mutateAsync` method is stable across renders even when
the wrapper object isn't; reading it through a ref makes that
contract explicit at the call site.

References:
- [React — useCallback: preventing an Effect from firing too often](https://react.dev/reference/react/useCallback#preventing-an-effect-from-firing-too-often)

### Cache subscriber action filter

`queryClient.getQueryCache().subscribe(...)` is the low-level
imperative API for reacting to cache changes. Prefer the declarative
path — `const { data } = useFooQuery(...)` plus `useEffect(...,
[data])` — whenever possible. The query data is stable per render
and updates only on observer-meaningful changes; the `useEffect`
gets unmount cleanup for free.

If you genuinely need the cache subscriber (e.g. cross-store
coordination outside the component tree), remember that
`event.type === "updated"` fires for **every** state transition —
not just successful data writes:

```ts
queryClient.getQueryCache().subscribe((event) => {
  if (event.type !== "updated") return;
  if (event.action.type !== "success") return; // ← required
  // ... read cache and apply
});
```

Without the action filter, a scheduled
`queryClient.invalidateQueries(...)` immediately fires an
`invalidate` action; if your subscriber reads the cache and reacts
to it, you'll be projecting the stale pre-invalidation value before
the refetch completes. `setQueryData` (used to seed the cache from
mutation responses) also dispatches `success`, so seeded paths still
fire here.

References:
- [TanStack Query — `QueryCache`](https://tanstack.com/query/latest/docs/reference/QueryCache)

### Imperative `fetchQuery` and global `staleTime`

The app's `QueryClient` (configured in
`apps/web/src/components/providers.tsx`) sets a default
`staleTime` (10 seconds at the time of writing). When you call
`queryClient.fetchQuery({ queryKey, queryFn })` without passing
your own `staleTime`, the global default applies — meaning a result
cached within the last 10 seconds resolves from cache **without
hitting the network**.

For imperative re-checks where freshness matters (visibility-change
handlers, retry buttons, post-action verification), pass
`staleTime: 0`:

```ts
const result = await queryClient.fetchQuery({
  queryKey,
  queryFn,
  staleTime: 0, // imperative re-checks must hit the network
});
```

The global default is the correct policy for ordinary subscribers
(`useFooQuery()`), but the imperative path has a different contract
("I need the truth now, not a cached truth from N seconds ago").
Naming the override at the call site beats relying on a cross-file
implicit default.

References:
- [TanStack Query — `staleTime`](https://tanstack.com/query/latest/docs/reference/QueryClient#queryclientfetchquery)

### Post-mutation cache seeding vs invalidation

When a mutation returns server state in the same shape your query
fetches, prefer `setQueryData` over `invalidateQueries`:

```ts
const result = await fooMutation.mutateAsync(input);
if (result.ok) {
  // Skip a redundant round-trip — the mutation response already
  // carries what a re-fetch would return.
  queryClient.setQueryData<QueryResult>(QUERY_KEY, {
    ok: true,
    status: result.status,
    data: result.data,
  });
}
```

Reach for `invalidateQueries` when:
- The mutation is fire-and-forget (no usable response payload).
- The mutation's response shape doesn't match the query's, OR
- You genuinely need to verify against the server's current state.

The seed path is also what makes polling restart correctly after a
mutation that flips the resource into a transient state — the
query's `refetchInterval` reads the cached value to decide whether
to keep polling, and a stale pre-mutation cache (e.g. a 404 that
the mutation just resolved) would otherwise keep the query idle.

References:
- [TanStack Query — `setQueryData`](https://tanstack.com/query/latest/docs/reference/QueryClient#queryclientsetquerydata)
- [TanStack Query — `invalidateQueries`](https://tanstack.com/query/latest/docs/reference/QueryClient#queryclientinvalidatequeries)

### Retry backoff for controlled-budget recovery

`refetchInterval` consults the cached data on every tick to decide
whether to keep polling. If the cache is a 404 / undefined that
your `pollIntervalFor` decision function treats as terminal,
**polling stops**. Replacing a `setTimeout`-driven retry loop that
relied on polling-as-retry needs explicit handling.

For a controlled budget like "3 attempts spaced 3 seconds apart,
then give up," don't `invalidateQueries` immediately on failure —
that triggers an immediate refetch (still 404), which fires the
cache subscriber (or `useEffect` on data), which re-enters the
auto-hatch / retry branch. The original 3-second backoff between
attempts collapses to milliseconds and the retry budget burns
before the user sees any feedback.

```ts
if (shouldRetry(result)) {
  setState({ kind: "initializing" });
  // Preserve the 3-second backoff between attempts.
  setTimeout(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, POLL_INTERVAL_MS);
  return;
}
```

Clean the `setTimeout` up on unmount — store the handle in a ref,
clear it in an effect cleanup — so navigation during the backoff
doesn't trigger a wasted refetch.

References:
- [React — Synchronizing with Effects: cleanup](https://react.dev/learn/synchronizing-with-effects#how-to-handle-the-effect-firing-twice-in-development)
- [TanStack Query — Network mode & retries](https://tanstack.com/query/latest/docs/framework/react/guides/network-mode)

## useReducer is not used for client state

**Do not use `useReducer` in `apps/web/`.** All client state — including
single-hook-scoped state with non-trivial transitions — lives in a
Zustand store with direct named actions (see
[Direct named actions, not reducers](#direct-named-actions-not-reducers)
just below). The dispatch/action-type/reducer pattern is not the
shape we want even inside a Zustand store — Zustand's
[Flux-inspired practice guide](https://zustand.docs.pmnd.rs/guides/flux-inspired-practice)
exists for Redux migration paths, not as the recommended idiom.

```ts
// Good — Zustand store with direct named actions
const useSecretStore = createSelectors(
  create<SecretState>((set) => ({
    requestId: null,
    prompt: null,
    showSecret: (requestId: string, prompt: string) =>
      set({ requestId, prompt }),
    dismissSecret: () => set({ requestId: null, prompt: null }),
  })),
);

// Avoid — useReducer in any form. Locks state to one component subtree,
// prevents atomic selectors, no devtools, doesn't survive remount,
// duplicates the React state primitive we already use Zustand for.
const [state, dispatch] = useReducer(secretReducer, initialState);

// Avoid — dispatcher pattern inside a Zustand store. Zustand supports
// this for Redux migrants but it's not idiomatic; named actions are
// independently testable, discoverable in IDE autocomplete, and don't
// pay the action-type/switch tax.
create((set) => ({
  dispatch: (action: SecretAction) =>
    set((state) => secretReducer(state, action)),
}));
```

Why no `useReducer` and no in-store reducer pattern:

- **Consistency** — the codebase standardizes on Zustand stores with direct named actions as the single client-state primitive.
- **Cross-component subscribers** — Zustand atomic selectors handle this for free; `useReducer` requires Context wrapping + cross-tree re-renders.
- **Devtools** — Zustand integrates with Redux DevTools; `useReducer` doesn't.
- **Persistence across remounts** — module-level Zustand stores survive route remounts; `useReducer` state doesn't.
- **No prop drilling** — `useReducer` state must be passed down or wrapped in Context. Zustand selectors are accessible everywhere.
- **No dispatcher boilerplate** — direct named actions skip the action-type union, the switch statement, and the runtime cost of an indirection layer. Each action is a plain function that's testable in isolation.

For state with complex transition rules (state machines), express the
rules as guards inside the named action itself — e.g. `acceptSend`
no-ops if `phase !== "thinking"`. The action stays a plain function;
the rules stay testable in isolation; we don't need a dispatcher
ceremony to enforce them.

**Known exceptions** (slated for migration):

- `apps/web/src/domains/terminal/use-terminal-state.ts` and
  `apps/web/src/domains/terminal/use-terminal-session.ts` still use
  `useReducer` + dispatch. These will be migrated to Zustand stores
  in a future change. Do not pattern-match new code on these files.

References:
- [Zustand — Auto Generating Selectors](https://zustand.docs.pmnd.rs/guides/auto-generating-selectors)
- [Zustand — TypeScript guide](https://zustand.docs.pmnd.rs/guides/typescript)

## Direct named actions, not reducers

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
