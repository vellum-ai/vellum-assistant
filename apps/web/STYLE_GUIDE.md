# Web App — Style Guide

Coding style, naming conventions, and formatting rules for the Vellum
web app. For architectural decisions and patterns see
[`CONVENTIONS.md`](./CONVENTIONS.md).

Subordinate to [`apps/AGENTS.md`](../AGENTS.md) and root
[`AGENTS.md`](../../AGENTS.md).

---

## File and folder naming

### kebab-case everywhere

All files and directories use `kebab-case`. This avoids
case-insensitive filesystem collisions (macOS HFS+, Windows NTFS) and
keeps imports predictable.

```
use-send-message.ts        # hook
message-handlers.ts         # module
conversation-reducer.ts     # reducer
chat-body.tsx               # component
stream-event-types.ts       # types
```

The only exceptions are `App.tsx` (conventional React entry-point name)
and generated files that follow their generator's convention.

Reference: [TypeScript Deep Dive — File naming](https://basarat.gitbook.io/typescript/styleguide#filename)

### Component filenames match the export

The file name is the kebab-case version of the default/named export.
`ChatBody` lives in `chat-body.tsx`, `useSendMessage` lives in
`use-send-message.ts`.

### Hook files start with `use-`

Files that export a custom hook as their primary export are prefixed
with `use-`. This mirrors the React convention that hooks are functions
whose names start with `use`.

Reference: [React — Rules of Hooks](https://react.dev/reference/rules/rules-of-hooks)

### Test files use `.test.ts` / `.test.tsx`

Colocated test files append `.test` before the extension:
`message-handlers.test.ts` alongside `message-handlers.ts`.

---

## Directory structure

```
src/
  App.tsx                    # root layout component
  main.tsx                   # entry point (createRoot, RouterProvider)
  routes.tsx                 # route tree (createBrowserRouter)
  domains/                   # business domain modules
    messages/                # message lifecycle
    conversations/           # conversation CRUD, grouping, selection
    streaming/               # SSE transport, event parsing
    interactions/            # user-facing prompts
    voice/                   # STT, TTS, PTT
    ...
  hooks/                     # cross-domain shared hooks
  utils/                     # cross-domain shared utilities (pure functions)
  types/                     # cross-domain shared types
  lib/                       # configured third-party wrappers (API client, Sentry, CSRF)
  runtime/                   # framework adapters, platform bridges
  components/                # cross-domain shared UI
  generated/                 # auto-generated code (HeyAPI, catalogs)
```

### Domain folders own their code

Each domain folder contains its hooks, store, reducers, handlers,
types, tests, and domain-specific components. See
[CONVENTIONS.md — Code organization](./CONVENTIONS.md#code-organization).

### Top-level shared directories

Cross-domain code lives in top-level `hooks/`, `utils/`, `types/`,
`lib/`, `runtime/`, and `components/`. If something is used by only
one domain, it belongs inside `domains/<name>/`.

### Shared UI components

Reusable, domain-agnostic UI components live in `components/` for
cross-domain shared UI. The design system (Button, Card, Modal, etc.)
lives in `packages/design-library/` and is imported as
`@vellum/design-library`. Components in `components/` must not import
domain state or feature hooks.

Domain-specific compositions of design library components (e.g. a
wrapper that injects OAuth link handling) belong in their domain
directory (`domains/<name>/components/`), not in `components/`. See
[CONVENTIONS.md — Injecting app-specific behavior](./CONVENTIONS.md#injecting-app-specific-behavior).

---

## Imports

### Use path aliases

Use the `@/` alias (mapped to `src/`) for imports outside the current
directory. Use relative imports (`./ `, `../`) only within the same
feature module.

```ts
// Good — alias for cross-module imports
import { useMessageStore } from "@/domains/messages/use-message-store.js";

// Good — relative within same domain
import { messageReducer } from "./message-reducer.js";

// Avoid — deep relative path crossing module boundaries
import { useMessageStore } from "../../../domains/messages/use-message-store.js";
```

Reference: [Vite — resolve.alias](https://vite.dev/config/shared-options.html#resolve-alias)

### Import order

Group imports in this order, separated by blank lines:

1. **External packages** (`react`, `react-router`, `@vellum/design-library`, etc.)
2. **Alias imports** (`@/domains/...`, `@/components/...`, `@/lib/...`)
3. **Relative imports** (`./`, `../`)

```ts
import { useCallback, useMemo } from "react";
import { useParams } from "react-router";
import { Button } from "@vellum/design-library";

import { useMessageStore } from "@/domains/messages/use-message-store.js";

import { messageReducer } from "./message-reducer.js";
```

Reference: [typescript-eslint — Organizing imports](https://typescript-eslint.io/rules/consistent-type-imports/)

### Destructured React type imports

Always destructure specific types from the `react` import. Do not use
the `React.TypeName` namespace pattern.

```ts
// Good
import { type ReactNode, type Dispatch, type SetStateAction, useCallback } from "react";

// Avoid
import React from "react";
function Foo(): React.ReactNode { /* ... */ }
```

Reference: [React — TypeScript](https://react.dev/learn/typescript)

### Use `type` imports for type-only symbols

Mark imports that are only used as types with the `type` keyword. This
ensures they are erased at build time and prevents accidental runtime
dependencies on type-only modules.

```ts
import { type Conversation } from "@/domains/conversations/types.js";
import type { DisplayMessage } from "@/domains/messages/types.js";
```

Both `import { type X }` and `import type { X }` are acceptable.
Prefer `import { type X }` when mixing value and type imports from the
same module; use `import type { X }` when importing only types.

Reference: [TypeScript — Type-Only Imports](https://www.typescriptlang.org/docs/handbook/modules/reference.html#type-only-imports-and-exports)

---

## TypeScript

### Strict mode

`tsconfig.json` enables `"strict": true`. Do not suppress strict checks
with `as any`, `@ts-ignore`, or `@ts-expect-error` unless there is a
documented reason in a comment.

### Prefer `interface` for object shapes

Use `interface` for object types that may be extended or implemented.
Use `type` for unions, intersections, mapped types, and utility types.

```ts
// Good
interface ChatRouteContentProps {
  messages: DisplayMessage[];
  turnState: TurnState;
}

// Good — union
type MainView = "chat" | "intelligence" | "library";
```

Reference: [TypeScript — Interfaces vs Types](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#differences-between-type-aliases-and-interfaces)

### No `any`

Do not use `any`. Use `unknown` when the type is genuinely unknown, then
narrow before use. Do not use `getattr`, `setattr`, or dynamic property
access as substitutes for understanding the type.

### Const assertions for fixed values

Use `as const` for literal arrays and objects that should not be
mutated.

```ts
const MAIN_VIEWS = ["chat", "intelligence", "library"] as const;
type MainView = (typeof MAIN_VIEWS)[number];
```

Reference: [TypeScript — const assertions](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-4.html#const-assertions)

---

## Components

### Named exports, not default exports

Use named exports for all components, hooks, and modules. Named exports
are refactor-safe (renaming is caught by the compiler) and allow
consistent import names across the codebase.

```ts
// Good
export function ChatBody(props: ChatBodyProps) { /* ... */ }

// Avoid
export default function ChatBody(props: ChatBodyProps) { /* ... */ }
```

Reference: [typescript-eslint — no-default-export](https://github.com/import-js/eslint-plugin-import/blob/main/docs/rules/no-default-export.md)

### Function declarations for components

Use function declarations (not arrow function expressions) for
components. This keeps component names visible in stack traces and React
DevTools.

```ts
// Good
export function ConversationDetail() { /* ... */ }

// Avoid
export const ConversationDetail = () => { /* ... */ };
```

### Props interfaces are named `{Component}Props`

```ts
interface ChatBodyProps {
  messages: DisplayMessage[];
  onSubmit: (content: string) => void;
}

export function ChatBody({ messages, onSubmit }: ChatBodyProps) { /* ... */ }
```

---

## Hooks

### Custom hooks start with `use`

All custom hooks follow the React naming convention: `useSendMessage`,
`useConversationLoader`, `useInteractionActions`.

Reference: [React — Rules of Hooks](https://react.dev/reference/rules/rules-of-hooks)

### Return explicit types, not inferred tuples

When a hook returns multiple values, return a named object rather than a
positional tuple. Named fields are self-documenting and refactor-safe.

```ts
// Good
function useSendMessage() {
  return { sendMessage, queuedMessages, handleStopGenerating };
}

// Avoid — positional meaning is fragile
function useSendMessage() {
  return [sendMessage, queuedMessages, handleStopGenerating];
}
```

---

## Constants and enums

### SCREAMING_SNAKE_CASE for module-level constants

```ts
const MAX_RETRY_COUNT = 3;
const DEFAULT_PAGE_SIZE = 50;
```

### No TypeScript enums

Use `as const` objects or union types instead of `enum`. Enums have
runtime cost and non-standard erasure behavior.

```ts
// Good
const Status = { IDLE: "idle", LOADING: "loading", ERROR: "error" } as const;
type Status = (typeof Status)[keyof typeof Status];

// Avoid
enum Status { IDLE, LOADING, ERROR }
```

Reference: [TypeScript — Enums are considered harmful](https://www.youtube.com/watch?v=jjMbPt_H3RQ)

---

## Docstrings

### JSDoc on public hooks and modules

Add a JSDoc comment on every exported hook, reducer, and utility module
explaining its purpose and any important constraints.

```ts
/**
 * Manages the lifecycle of sending a message — optimistic append,
 * attachment resolution, queue management, and stop-generation.
 *
 * Must be called within a ChatProvider context.
 */
export function useSendMessage() { /* ... */ }
```

### No redundant comments

Do not add comments that restate the code. Rely on clear naming.
Comments should explain *why*, not *what*.

```ts
// Avoid
// Set the message count
const messageCount = messages.length;

// Good — explains non-obvious constraint
// Circuit-break compaction requests for 30s after a failure to avoid
// hammering the endpoint during outages.
const COMPACTION_CIRCUIT_OPEN_MS = 30_000;
```

---

## Formatting

### Prettier / editor defaults

Use the project's Prettier config (or editor defaults if no Prettier
config exists). Do not commit formatting-only changes in feature PRs.

### Trailing commas

Use trailing commas in multi-line arrays, objects, function parameters,
and type parameters. This produces cleaner diffs.

```ts
const props = {
  messages,
  turnState,
  onSubmit,  // trailing comma
};
```

Reference: [Prettier — Trailing Commas](https://prettier.io/docs/options.html#trailing-commas)

### Double quotes for strings

Use double quotes for string literals to match the TypeScript ecosystem
default and Prettier's default configuration.

```ts
import { useCallback } from "react";
const label = "Send message";
```

---

## Unused code

### Prefix unused variables with `_`

ESLint is configured to allow variables prefixed with `_`:

```ts
const [_unused, setCount] = useState(0);
voice.setVoiceError; // -> rename to _setVoiceError if intentionally unused
```

Reference: [typescript-eslint — no-unused-vars](https://typescript-eslint.io/rules/no-unused-vars/)

### Delete dead code in the same PR

When extracting or inlining logic, remove the original in the same PR.
Do not leave dead imports, unused functions, or commented-out blocks.
Unrelated dead code spotted during a PR gets its own separate PR opened
at the same time — never just filed as an issue and left.
See [CONVENTIONS.md — Dead code and cleanup](./CONVENTIONS.md#dead-code-and-cleanup).
