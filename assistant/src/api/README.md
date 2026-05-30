# @vellumai/assistant-api

Public API surface for consumers of the assistant runtime — web client, gateway,
evals, future external clients. This directory is the **source of truth** for
the wire contracts the assistant exposes: schemas, types, and pure helpers.

Internal assistant code imports the files in this directory via relative paths
(e.g. `../../api/events/open-url.js`). External consumers import the
materialized npm-style package `@vellumai/assistant-api`, regenerated into
`apps/web/node_modules/` by `apps/web/scripts/postinstall.ts`.

## Architecture

A single discriminated-union schema, `AssistantEventSchema`, covers every event
type whose wire contract is canonical. The web parser (`event-parser.ts`) tries
this schema first; events not yet covered fall through to a hand-rolled legacy
switch. The migration goal is to drain the switch — each event moved here
shrinks the legacy surface and makes wire-shape drift a compile error.

`AssistantEvent` (re-exported alongside the schema) is `z.infer<typeof
AssistantEventSchema>`. Consumers reference this single type rather than
re-listing the individual member types: as new events migrate in, they appear
in `AssistantEvent` automatically.

## Migration recipe

Each batch follows the same shape. Group cohesive event families (lifecycle,
streaming, document-comment, ui-surface, etc.) rather than migrating events
one at a time — the per-batch overhead is the same regardless of count.

### 1. Add the canonical schema

One file per event under `./events/`. Schemas use Zod's default strip
mode — unknown fields are silently discarded during parsing so the
server can add transport-level metadata (e.g. `seq`) without breaking
client validation.

```ts
// assistant/src/api/events/my-event.ts
import { z } from "zod";

export const MyEventSchema = z.object({
  type: z.literal("my_event"),
  conversationId: z.string(),
  // …
});

export type MyEvent = z.infer<typeof MyEventSchema>;
```

Add the type/schema re-export pair to `./index.ts`, alphabetically, and append
the schema to the `AssistantEventSchema` discriminated union. No other changes
to the canonical package are needed — `AssistantEvent` picks the new member
up automatically.

### 2. Adopt the canonical type in daemon code

In `assistant/src/daemon/message-types/<domain>.ts`, delete the local
`interface MyEvent { … }` declaration and import the canonical `MyEvent`
type from `../../api/events/my-event.js`. The domain-level
`_<Domain>ServerMessages` union alias (consumed by `message-protocol.ts`)
keeps its existing shape — it just references the canonical types now.

**Do not add `export type MyEventLocalName = MyEvent` alias bridges in the
daemon message-types files.** They shadow the canonical name and create a
second name for the same thing — exactly the drift this directory exists to
prevent. Reference the canonical `*Event` name directly inside the
`_<Domain>ServerMessages` aggregator union, and have downstream daemon
consumers import the canonical type from `../../api/events/<name>.js` at the
use site. The only thing that should live in `message-types/<domain>.ts` for
a migrated event is the import and the union membership.

### 3. Cut over web consumers

`apps/web/src/domains/chat/api/event-types.ts` no longer needs to list the
migrated event in its `AssistantEvent` union — `APIAssistantEvent` covers it.
Drop the per-event member, leaving the union to peel off legacy entries one
at a time as each event migrates.

Local handler modules (e.g. `document-comment-events.ts`) keep their handler
functions but import the wire types directly from `@vellumai/assistant-api`.
Do **not** re-export the canonical types from intermediate modules — consumers
import them straight from the canonical package.

### 4. Delete the legacy parser cases

Remove the matching `case "my_event":` blocks from
`apps/web/src/domains/chat/api/event-parser.ts`. Any per-event helper
(`parseFooBase`, etc.) goes with them.

### 5. Tests

Add parser tests for each migrated event covering:

- happy path with all fields
- minimal required only
- missing required field → `UnknownEvent`
- unknown extra field is silently stripped, event still parses

For happy-path tests, inline the discriminator literal in both the input and
the expected object. `const data = { type: "my_event", … }` widens
`data.type` to `string`, breaking the discriminated-union match when the
result is compared with `toEqual(data)`.

Handler-level tests in the consuming domain modules typically need no change
— the canonical types are wire-compatible with the previous local interfaces.

### 6. Local greenlight gate

Run before push, in order:

```bash
# In apps/web — regenerate the @vellumai/assistant-api bundle
bun run scripts/postinstall.ts

# Type-check both packages
( cd assistant && bunx tsc --noEmit )
( cd apps/web && bunx tsc --noEmit )

# Targeted tests
( cd apps/web && bun test src/domains/chat/api/event-parser.test.ts )

# Lint + format the touched files
bunx eslint <files>
bunx prettier --write <files>
```

`format:check` is a distinct CI gate from `lint`; format the touched files
before push.
