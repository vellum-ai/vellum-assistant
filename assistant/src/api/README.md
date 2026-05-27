# @vellumai/assistant-api

Public API surface for consumers of the assistant runtime — web client, gateway,
evals, future external clients. This directory is the **source of truth** for
the wire contracts the assistant exposes: schemas, types, and pure helpers.

Internal daemon code imports the files in this directory via relative paths
(e.g. `../../api/events/open-url.js`). External consumers import the
materialized npm-style package `@vellumai/assistant-api`, regenerated into
`apps/web/node_modules/` by `apps/web/scripts/postinstall.ts`.

## Architecture

A single discriminated-union schema, `AssistantEventSchema`, covers every event
type whose wire contract is canonical. The web parser (`event-parser.ts`) tries
this schema first; events not yet covered fall through to a hand-rolled legacy
switch. The migration goal is to drain the switch — each event moved here
shrinks the legacy surface and makes wire-shape drift a compile error.

### Parse flow (`apps/web/src/domains/chat/api/event-parser.ts`)

```
raw SSE payload
      │
      ▼
unwrapEnvelope               ← splits `{ message, conversationId }`
      │                        envelope-shape from flat-shape; returns
      │                        { inner, envelopeConversationId }
      ▼
AssistantEventSchema.safeParse(inner)
      │
      ├── success → typed event
      │              │
      │              ▼
      │       (if conversation-scoped AND inner has no conversationId)
      │       graft envelopeConversationId onto event
      │              │
      │              ▼
      │            return
      │
      └── failure → parseLegacyEvent(mergeEnvelopeConversationId(inner, env))
                         │
                         ▼  hand-rolled switch over `data.type`
                       return
```

### Invariants

1. **Schemas see the pure inner message.** The envelope-level `conversationId`
   is a routing key, not an event field — it is NOT merged onto `inner`
   before schema parsing. This keeps strict global schemas (e.g.
   `RelationshipStateUpdatedEventSchema`) unable to accept envelope-leaked
   conversationId; if one ever appears, `.strict()` rejects it and the event
   falls through to legacy → `unknown`.

2. **Schemas are `.strict()`.** Unknown keys are rejected. Drift surfaces
   immediately rather than silently accumulating.

3. **Conversation-scoped events declare `conversationId` as optional.** The
   daemon is not required to put `conversationId` on the inner message — the
   SSE pipe attaches it at the envelope level for per-conversation streams.
   On schema-success, the parser grafts `envelopeConversationId` onto the
   typed event when the inner didn't already declare one, so downstream
   per-conversation filters and defense-in-depth gates can route correctly.

4. **Global events do not declare `conversationId`.** Global events ride the
   home SSE stream, not a conversation stream, so there is no envelope
   conversationId to graft. Strict schemas without `conversationId` express
   this contract directly.

## Migrating a legacy event to the schema

For an event `foo_bar`:

1. **Create the schema file** at `assistant/src/api/events/foo-bar.ts`:

   ```ts
   import { z } from "zod";

   export const FooBarEventSchema = z
     .object({
       type: z.literal("foo_bar"),
       // ...required fields
       // ...optional fields (use .optional() for genuinely optional ones)
       // For conversation-scoped events, include:
       conversationId: z.string().optional(),
     })
     .strict();

   export type FooBarEvent = z.infer<typeof FooBarEventSchema>;
   ```

   Include a docstring explaining when the event is emitted, what receivers do
   with it, and (for conversation-scoped events) a note that
   `conversationId` is the parser-grafted routing key.

2. **Re-export from `assistant/src/api/index.ts`** and append to the
   discriminated union (keep alphabetical):

   ```ts
   import { FooBarEventSchema } from "./events/foo-bar.js";
   export { type FooBarEvent, FooBarEventSchema } from "./events/foo-bar.js";

   export const AssistantEventSchema = z.discriminatedUnion("type", [
     // ...existing members
     FooBarEventSchema,
   ]);
   ```

3. **Regenerate the materialized package** so `apps/web` sees the new schema:

   ```sh
   cd apps/web && bun run scripts/postinstall.ts
   ```

   This copies `assistant/src/api/` into `apps/web/node_modules/@vellumai/assistant-api/`
   and rewrites the `package.json` to declare `zod` as a real dep.

4. **Delete the corresponding `case "foo_bar":` from the legacy switch** in
   `apps/web/src/domains/chat/api/event-parser.ts`. The schema dispatch will
   catch it first.

5. **Wire web's typed alias.** If `apps/web/src/domains/chat/api/event-types.ts`
   declares a local `FooBarEvent` interface, replace it with a re-export:

   ```ts
   import type { FooBarEvent } from "@vellumai/assistant-api";
   export type { FooBarEvent } from "@vellumai/assistant-api";
   ```

6. **Replace the daemon-side interface** if `assistant/src/daemon/message-types/`
   declares a parallel type. Import `FooBarEvent` from `../../api/events/foo-bar.js`
   and update the message-type union.

7. **Add envelope-graft tests** in `apps/web/src/domains/chat/api/event-parser.test.ts`
   (for conversation-scoped events). Cover:
   - Envelope `conversationId` grafted when inner doesn't declare one.
   - Inner `conversationId` wins when both are present.

8. **Run the checks:**

   ```sh
   cd apps/web && bun test src/domains/chat/api/event-parser.test.ts
   cd apps/web && bunx tsc -p tsconfig.json --noEmit
   cd apps/web && bunx eslint src/domains/chat/api/event-parser.ts
   cd assistant && bunx tsc -p tsconfig.json --noEmit
   ```

## Picking what to migrate next

Good candidates first:
- **Low-traffic + simple shape** — minimizes risk, exercises the recipe end-to-end.
- **Global before high-volume conversation-scoped** — globals avoid the
  envelope-graft path entirely.

Save for last:
- **High-volume hot-path events** (`assistant_text_delta`, `tool_use_start`)
  where a regression in schema dispatch is visible immediately.
- **Events with deeply nested shapes** (`assistant_activity_state` with its
  phase/reason/anchor enums) until the schema vocabulary is established.

## Reference

- Wire-contract source: `assistant/src/api/events/*.ts`
- Materialization script: `apps/web/scripts/postinstall.ts`
- Parser: `apps/web/src/domains/chat/api/event-parser.ts`
- Strict-schema invariant test: `apps/web/src/domains/chat/api/event-parser.test.ts`
  (search for "envelope-level conversationId is NOT stamped onto strict-schema events")
- Examples already migrated:
  - `relationship_state_updated` (global, strict, no conversationId)
  - `open_url` (conversation-scoped, optional conversationId, envelope-grafted)
