# @vellumai/assistant-api

Public API surface for consumers of the assistant daemon (web client, gateway,
evals, future external clients). This directory is the **source of truth** for
the wire contracts the daemon exposes — schemas, types, and pure helpers.

## Why this lives in `assistant/src/`

Historically, shared types between the daemon and the web client lived in
`/packages/skill-host-contracts` and similar packages, wired into consumers via
`file:../packages/foo` dependencies. That pattern bloats the Dockerfile (every
package needs its own `COPY` + `bun install`) and adds package-management
overhead for what is, in practice, source code shared across modules in a
single repo at a single version.

This module adopts the **plugin-api pattern** instead: the source lives next to
its owner (the assistant daemon, since the daemon is the wire authority), and
consumers resolve `@vellumai/assistant-api` via `tsconfig.paths` + Vite alias
rather than via a `file:` dep. Result: no extra `COPY` lines, no per-package
install, no transitive lockfile entries.

See `/workspace/notes/packages-architecture-thinking.md` (in the ApolloBot
workspace) for the full rationale.

## What belongs here

- **Zod schemas** for wire payloads (SSE events, HTTP request/response shapes)
- **TypeScript types inferred from those schemas** (`z.infer<...>`)
- **Pure helper functions** for constructing/parsing wire-shaped data (no I/O,
  no daemon runtime imports)
- **Constants** that are part of the wire contract (e.g. `SYNC_TAGS`)

## What does NOT belong here

- Any import from `assistant/src/daemon/`, `assistant/src/runtime/`,
  `assistant/src/agent-loop/`, or any other daemon-runtime module — those
  would couple consumers to the daemon's full dep graph.
- Anything that requires Node/Bun-specific APIs (fs, net, etc.). This must
  stay isomorphic so browser consumers can import it.
- HTTP fetch helpers — those are client-specific (web vs. gateway have
  different transport concerns).

## Layout

```
api/
├── package.json     # declares @vellumai/assistant-api (private, source-as-package)
├── README.md
├── index.ts         # public barrel
└── sse-events/      # one file per event-source domain
    ├── index.ts
    └── sync.ts      # sync_changed wire schema + tag namespace
```

Adding a new event:
1. Add the zod schema + inferred type in the appropriate `sse-events/*.ts`
   (or create a new file if the domain is new).
2. Export it from the file's nearest barrel.
3. Have the daemon's `daemon/message-types/<domain>.ts` re-export the type
   so existing daemon imports keep working.
4. Have web consumers' parsers call `Schema.safeParse(data)` instead of
   hand-rolling `typeof data.x === "string" ? data.x : ""` boilerplate.

## Allowed runtime dependencies

- `zod` — schema validation, intentional shared dep.
- (none else, for now)

Anything added here must keep the dep tree minimal — web bundles import this
module and pay for every transitive dep.
