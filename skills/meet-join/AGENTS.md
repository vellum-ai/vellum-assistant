# Meet-join skill — Agent Instructions

All Meet runtime code lives under this directory. The daemon module, tools,
routes, config schema, wire-contracts, and Meet-bot container image are all
consolidated here so the skill can evolve — or be lifted out of the repo
entirely — without hunting down scattered references across the monorepo.

## The isolation rule

The `assistant/` module must **never** import from `skills/meet-join/` via
relative paths. The Docker build copies `assistant/` and `packages/` but not
`skills/`, so any such import breaks at runtime.

Skills wire into the assistant through registries:

- **Tools**: `registerExternalTools()` in `assistant/src/tools/tool-manifest.ts`
- **Routes**: `registerSkillRoute()` in `assistant/src/runtime/skill-route-registry.ts`
- **Shutdown**: `registerShutdownHook()` in `assistant/src/daemon/shutdown-registry.ts`

The assistant owns its own copy of `MeetServiceSchema` in
`assistant/src/config/schemas/meet.ts` for config composition. The skill's
`config-schema.ts` is the skill-internal copy.

## When you need a new external reference

Before adding a new reference to `skills/meet-join/` from outside the skill,
check whether the new code could instead live inside `skills/meet-join/` or be
moved into `assistant/src/`.

## Central registries that stay put

A handful of central files reference Meet by design — they are per-domain
entries in a repo-wide registry, and splitting one entry out into the skill
would break the "one file per domain" pattern the registry relies on. These
are **not** candidates for relocation into `skills/meet-join/`:

- **`assistant/src/daemon/message-types/meet.ts`** — the Meet entry in the
  daemon-client SSE wire-protocol index. Each domain has one file here
  (`apps.ts`, `browser.ts`, `contacts.ts`, etc.), all re-exported from
  `assistant/src/daemon/message-protocol.ts`. Meet's server->client push
  message shapes (e.g. `MeetJoined`, `MeetTranscriptChunk`) live in this
  file alongside every other domain's wire types. This is protocol-level
  surface, not runtime code.

- **`meta/feature-flags/feature-flag-registry.json`** — the central
  declaration of every assistant feature flag, including `meet`. This is
  the canonical flag registry; per-flag entries are not relocated to
  owning skills.
