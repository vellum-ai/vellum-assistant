# Web App — State Management

How client state and server state are managed in `clients/web/`. Zustand
stores for client state, TanStack Query for server state, atomic
selectors, no `useReducer`.

See also [`clients/web/AGENTS.md`](../AGENTS.md) and the umbrella
[`CONVENTIONS.md`](./CONVENTIONS.md).

---



## Zustand for shared mutable state

Use [Zustand](https://github.com/pmndrs/zustand) for *client* state shared
across multiple components — composer drafts, turn state, interactions,
viewer state, UI expansion. Server data (conversation history, the
conversation list) is NOT Zustand state — it lives in its TanStack Query
cache (see [Data fetching](#data-fetching-react-query-vs-direct-sdk-calls)),
and the store holds only what the server doesn't have yet (e.g. the in-flight
turn). Zustand was chosen over Context + useReducer because:

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

## When Zustand does NOT apply: stateless registries

The "all shared client state lives in Zustand" rule means *state* —
values consumers read and react to. A handler registry (the event bus,
in `lib/event-bus.ts`) is not state. It's a pub/sub primitive where
the only data is a `Map<event, Set<handler>>` that consumers never
read, only write to and dispatch through. There's nothing for
selectors to subscribe to. Wrapping it in a Zustand store adds
ceremony without value — `useEventBusStore.getState().publish(...)`
when `publish(...)` is the actual operation.

The convention: stateless pub/sub registries are plain modules with
exported functions. They live in `lib/` alongside other app
infrastructure. The event bus is the canonical example; other
registries (if any are added) should follow the same shape.

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

// State — the data. This pattern is for CLIENT-owned state. Server data (e.g.
// conversation history) is never stored this way — read it from its TanStack
// Query cache and keep the store to what the server doesn't have yet.
export interface ComposerState {
  draft: string;
  attachmentIds: string[];
}

// Actions — direct named functions (no dispatch/reducer)
export interface ComposerActions {
  setDraft: (draft: string) => void;
  addAttachment: (id: string) => void;
  reset: () => void;
}

// Combined store type
export type ComposerStore = ComposerState & ComposerActions;

const useComposerStoreBase = create<ComposerStore>()((set) => ({
  draft: "",
  attachmentIds: [],
  setDraft: (draft) => set({ draft }),
  addAttachment: (id) =>
    set((s) => ({ attachmentIds: [...s.attachmentIds, id] })),
  reset: () => set({ draft: "", attachmentIds: [] }),
}));

export const useComposerStore = createSelectors(useComposerStoreBase);
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

## Status as one discriminated union, never parallel booleans

Model an async or multi-phase status as a single
[discriminated-union](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions)
field, not a pair of booleans. A `(isLoading, isLoggedIn)` pair has four
combinations but only three are legal — `(true, true)` ("loading yet already
logged in") is meaningless, and every reader has to remember which combination
means what. A single `sessionStatus: "initializing" | "authenticated" |
"unauthenticated"` makes the illegal state unrepresentable and names each phase
once.

```ts
// Avoid — parallel booleans: 4 states encode 3, (true,true) is illegal
interface AuthState { isLoading: boolean; isLoggedIn: boolean }

// Prefer — one field, every value legal and named
type SessionStatus = "initializing" | "authenticated" | "unauthenticated";
interface AuthState { sessionStatus: SessionStatus }
```

References:
- [TypeScript — Discriminated unions](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions)
- [Making illegal states unrepresentable](https://fsharpforfunandprofit.com/posts/designing-with-types-making-illegal-states-unrepresentable/)

## Where derivation lives: inline vs shared predicate

Deriving a value from store state (`status === "authenticated"`,
`user?.id`) belongs **inline in the consumer** when it is a one-off — keep the
store's surface minimal and the derivation next to where it's used.

Extract a **shared predicate** when the *same* derivation recurs across
modules. Re-encoding `status === "authenticated"` at six call sites leaks the
field's encoding to every reader: the question "is the user authenticated?"
should be answered in one place, so a change to the encoding touches one line.
Give the owning module two forms:

- a **pure predicate** `isAuthenticated(status)` for imperative readers
  (middleware, route resolvers, services) that already hold a value, and
- a **hook** `useIsAuthenticated()` that composes the predicate over an atomic
  selector, for reactive components.

```ts
// Pure predicate — owns the encoding, usable anywhere
export const isAuthenticated = (s: SessionStatus) => s === "authenticated";

// Hook — reactive read for components, composes the predicate
export const useIsAuthenticated = () =>
  isAuthenticated(useAuthStore.use.sessionStatus());
```

Keep pure predicates in a dependency-free module when modules the store
*depends on* must also read them — `import type` cannot break a cycle through a
runtime value (a predicate), only through a type.

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
const { sessionStatus } = useAuthStore.getState();
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

// Domain data — query factory spread into useQuery (used in components)
const { data } = useQuery({ ...assistantsListOptions() });
```

### Why React Query (not SWR or others)

- [HeyAPI `@tanstack/react-query` plugin](https://heyapi.dev/openapi-ts/plugins/tanstack-query) auto-generates typed query factories (`xxxOptions()`), mutation hooks (`useXxxMutation()`), and cache helpers (`setXxxQueryData()`) from the OpenAPI spec. No equivalent plugin exists for SWR (still in proposal stage) or other libraries — this alone is decisive given our HeyAPI codegen pipeline. See [`CONVENTIONS.md` — Generated artifacts](./CONVENTIONS.md#generated-artifacts-and-when-to-use-each) for when to use each layer.
- First-class mutation support, optimistic updates, and Redux-DevTools-style query inspection.
- 12M+ weekly downloads (2026), the most feature-complete option in the React server-state space.
- Boundary with Zustand is documented explicitly — see the section above. React Query handles server state; Zustand handles client state; they do not overlap.

References:
- [React Query — Overview](https://tanstack.com/query/latest/docs/framework/react/overview)
- [React Query — Comparison](https://tanstack.com/query/latest/docs/framework/react/comparison)
- [TkDodo — Working with Zustand](https://tkdodo.eu/blog/working-with-zustand) — React Query maintainer's guidance on the boundary between server state (RQ) and client/infrastructure state (Zustand)
- [Zustand — Reading/writing state outside components](https://zustand.docs.pmnd.rs/guides/reading-and-writing-state-outside-components)

### Event-driven cache updates

When an external signal (SSE event, bus message) indicates server data
has changed, the component rendering the data isn't the one responding
to the signal — an event handler is. Hooks can't be called inside event
handlers ([Rules of Hooks](https://react.dev/reference/rules/rules-of-hooks)),
so use `queryClient.fetchQuery` with the generated query-options factory:

```ts
import { conversationsByIdGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

// Inside a bus subscriber or event handler:
const data = await queryClient.fetchQuery({
  ...conversationsByIdGetOptions({ path: { assistant_id: id, id: convId } }),
  retry: false,
});
```

`fetchQuery` [deduplicates concurrent
requests](https://tanstack.com/query/latest/docs/reference/QueryClient#queryclientfetchquery)
for the same query key, populates the TanStack Query cache (so
mounted `useQuery` subscribers see the new data), and returns the
typed response. Set `retry: false` when the event stream provides
natural retry (the next event re-triggers the handler).

| Context | Tool | Why |
|---|---|---|
| React component rendering data | `useQuery({ ...xxxOptions() })` | Declarative; factory spread accepts all TQ options |
| Event handler, bus subscriber, loader | `queryClient.fetchQuery({ ...xxxOptions() })` | Imperative; outside React render cycle |
| Optimistic cache write | `setXxxQueryData()` | Typed; no network round-trip |

See [`CONVENTIONS.md` — Generated
artifacts](./CONVENTIONS.md#generated-artifacts-and-when-to-use-each)
for the full generated-artifact catalog and
[`EVENT_BUS.md` — Event-driven cache refresh](./EVENT_BUS.md#event-driven-cache-refresh-via-fetchquery)
for a concrete example.

References:
- [TanStack Query — `fetchQuery`](https://tanstack.com/query/latest/docs/reference/QueryClient#queryclientfetchquery)
- [HeyAPI — TanStack Query plugin](https://heyapi.dev/openapi-ts/plugins/tanstack-query)
- [React — Rules of Hooks](https://react.dev/reference/rules/rules-of-hooks)

### When to use `useState`

Not all state needs Zustand or React Query. Use plain `useState` when:

- The state is **ephemeral and page-local** — dialog open/close, drawer
  visibility, which tab is selected, inline form values.
- There is a **single consumer** — only the component that owns the
  state reads it. No sibling or distant component needs access.
- The state **doesn't survive navigation** — losing it on unmount is
  correct behavior, not a bug.

If any of these stop being true — a second component needs to read the
state, or it must persist across route changes — promote to a Zustand
store.

`useState` is the lightest primitive. Using Zustand or React Query when
`useState` suffices adds ceremony without value.

References:
- [React — `useState`](https://react.dev/reference/react/useState)
- [Zustand — When to use Zustand vs useState](https://zustand.docs.pmnd.rs/getting-started/introduction)

### Optimistic updates in mutations

TanStack Query supports two patterns for optimistic UI during mutations.
Choose based on whether the mutation's optimistic state needs to be
visible outside the mutating component.

**"Via the UI"** — derive optimistic display from the mutation's own
reactive state (`isPending`, `variables`). No cache manipulation, no
manual rollback. Use this when the mutation and query live in the
**same component**.

```ts
const deleteMutation = useDeleteContactMutation({
  onSettled: () => invalidateContacts(),
});

// Derive — don't imperatively set:
const deletingId = deleteMutation.isPending ? deleteMutation.variables : null;
const visibleContacts = contacts.filter((c) => c.id !== deletingId);
```

Rollback is automatic — when the mutation fails, `isPending` becomes
`false` and the derivation stops.

**"Via the Cache"** — write to the query cache in `onMutate`, roll back
in `onError`, invalidate in `onSettled`. Use this when optimistic state
must be visible to **multiple unrelated components** that read from the
same query cache.

**Always `cancelQueries` first** — an in-flight refetch (e.g. from
another mutation's `onSettled` invalidation or `refetchOnWindowFocus`)
can resolve after your optimistic write and overwrite it with stale
server data. `cancelQueries` aborts those requests so they can't
interfere.

**Roll back only the changed field, not the full snapshot** — if
concurrent mutations are possible (e.g. toggling profile A while
profile B is being edited), restoring a full-config snapshot from
`onMutate` would silently revert the other mutation's successful
optimistic update. Instead, capture only the specific field(s) you're
about to change, and in `onError` use an updater function to patch
only those fields back. This keeps the rest of the cache intact.

```ts
const mutation = usePatchItemMutation({
  onMutate: async (vars) => {
    await queryClient.cancelQueries({ queryKey: getItemQueryKey(vars.id) });
    // Snapshot only the field we're changing
    const previous = queryClient.getQueryData(getItemQueryKey(vars.id));
    // Optimistic update via the generated typed setter
    setItemQueryData(queryClient, vars.id, (old) =>
      old ? { ...old, isActive: vars.isActive } : old,
    );
    return { previousIsActive: previous?.isActive };
  },
  onError: (_err, vars, ctx) => {
    // Roll back only the changed field — concurrent updates to other
    // fields stay intact
    setItemQueryData(queryClient, vars.id, (old) =>
      old ? { ...old, isActive: ctx?.previousIsActive } : old,
    );
  },
  onSettled: (_data, _err, vars) =>
    queryClient.invalidateQueries({ queryKey: getItemQueryKey(vars.id) }),
});
```

When using "Via the Cache" and `onMutate` performs side effects beyond
`setQueryData` (e.g. `setState` calls), snapshot and restore those in
`onError` too — TanStack only manages cache rollback automatically.

References:
- [TanStack — Optimistic Updates](https://tanstack.com/query/v5/docs/framework/react/guides/optimistic-updates)
- [TkDodo — Concurrent Optimistic Updates](https://tkdodo.eu/blog/concurrent-optimistic-updates-in-react-query)

### Deriving state from mutations

Prefer deriving display values from mutation state over maintaining
parallel `useState`. If `useMutation` already tracks the value (error
message, pending variables, success result), read it from the mutation
instead of duplicating it in a `useState`.

```ts
// Avoid — duplicates mutation error state
const [error, setError] = useState<string | null>(null);
const mutation = useDoThingMutation({
  onError: (err) => setError(err.message),
});

// Prefer — derive from mutation
const mutation = useDoThingMutation();
const errorMessage = mutation.error?.message ?? null;
// Clear with mutation.reset() instead of setError(null)
```

### Org-readiness gating for daemon queries

Platform-mode daemon requests require the `Vellum-Organization-Id`
header. The org store hydrates asynchronously after auth, so queries
that mount before hydration completes (e.g. conversation queries on
the eager `ChatPage` path) must gate on `useIsOrgReady()`:

```ts
import { useIsOrgReady } from "@/hooks/use-is-org-ready";

const isOrgReady = useIsOrgReady();
const query = useQuery({
  ...assistantsListOptions({ query: { hosting: "platform" } }),
  enabled: enabled && Boolean(assistantId) && isOrgReady,
});
```

Queries mounted inside `<ActiveAssistantGate>` typically don't race
because the lifecycle resolves after org hydration, but the gate is
cheap and safe to add defensively.

Reference: [TanStack Query — Dependent Queries](https://tanstack.com/query/latest/docs/framework/react/guides/dependent-queries)

### Canonical migration example

When migrating an imperative `setTimeout`-driven fetch loop to
TanStack Query, the load-bearing patterns (mutation ref stability,
explicit `staleTime: 0` on imperative re-checks, `setQueryData`
post-mutation seeding, `setTimeout`-wrapped retry backoff,
`useEffect` on query data instead of the low-level
`queryClient.getQueryCache().subscribe(...)`) are demonstrated in
[`src/assistant/queries.ts`](../src/assistant/queries.ts) and
[`src/assistant/use-lifecycle.ts`](../src/assistant/use-lifecycle.ts).
Each load-bearing call site has an inline comment explaining the
invariant it preserves and the failure mode it prevents. Read those
files as the source of truth — they update with the code.

The same trio also demonstrates the **hook-as-side-effect +
Zustand-as-state** pattern: `use-lifecycle.ts` returns `void` and
publishes everything it produces (the `assistantState` discriminated
union, the stable imperative actions) into
[`src/assistant/lifecycle-store.ts`](../src/assistant/lifecycle-store.ts)
and [`src/assistant/selection-store.ts`](../src/assistant/selection-store.ts).
Consumers read via atomic selectors; nothing flows through outlet
context. This is the shape to copy when a side-effect orchestrator
needs to expose its state to the whole tree — not a `useReducer`,
not a Context provider, not a custom-hook return threaded through
layouts.

## useReducer is not used for client state

**Do not use `useReducer` in `clients/web/`.** All client state — including
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

## Service-owned state vs store-owned state

Module-level singleton services (e.g. `lifecycle-service.ts`) own
*behavior* — async work, retry budgets, watchdogs, transitions. Any
**state that React reads** lives in the service's Zustand store, not as
a private service field, even if there's only one consumer today.

The trap to avoid: a private singleton field + `peek()` method seems
fine when the only consumer reads it once at mount. It breaks the
moment a producer fires from *inside* the consumer's React tree
(rather than from a sibling that navigates to it) — the singleton flip
happens after the consumer's `useState` lazy initializer already
peeked, no re-render is triggered, the UI goes stale. Patching by
flipping a local mirror at the call site is a band-aid every future
in-tree producer would need to repeat.

Store-resident state avoids this entirely: `setState` on the store
automatically re-renders every subscriber, regardless of where the
producer fired from.

Services expose `mark<Field>()` / `clear<Field>()` (or `set<Field>(v)`)
that internally call `useTheStore.setState(...)`. React consumers read
via the atomic selector `useTheStore.use.field()`; non-React callers
read via `useTheStore.getState().field`. No mirror, no `peek`, no
two-state invariant.

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
interface TurnState {
  phase: TurnPhase;
  activeTurnId: string | null;
  activeToolCallCount: number;
}

interface TurnActions {
  startTurn: (turnId: string) => void;
  startStreaming: () => void;
  completeTurn: () => void;
  incrementToolCalls: () => void;
}

type TurnStore = TurnState & TurnActions;

export const useTurnStore = create<TurnStore>()((set, get) => ({
  phase: "idle",
  activeTurnId: null,
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
