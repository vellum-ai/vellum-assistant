# Meet-join skill — Agent Instructions

All Meet runtime code lives under this directory. The daemon module, tools,
routes, config schema, wire-contracts, and Meet-bot container image are all
consolidated here so the skill can evolve — or be lifted out of the repo
entirely — without hunting down scattered references across the monorepo.

## The isolation rule

Code outside `skills/meet-join/` must not import from the skill beyond a small,
explicit allowlist of wiring points: the central tool manifest, HTTP route
mount, config schema, daemon shutdown handler, and the daemon-client SSE
protocol registry. These are the places where a central registry has to know
about Meet — everywhere else, Meet is opaque.

The complete allowlist and enforcement live in
`assistant/src/__tests__/skill-meet-isolation.test.ts`. A guard test scans the
repo for references to `skills/meet-join/` and fails CI if any non-allowlisted
file imports from the skill.

## When you need a new external reference

Before adding a file to the allowlist, check whether the new registration
could instead live inside `skills/meet-join/` and be wired via one of the
existing central hooks. For example, a new tool belongs alongside the
existing ones in `skills/meet-join/tools/` and is surfaced via the existing
entry in `assistant/src/tools/tool-manifest.ts` — no new allowlist entry
required.

If you do need a new external reference (e.g. a new central registry has to
learn about Meet), add the file path to the `ALLOWLIST` in
`skill-meet-isolation.test.ts` with a comment explaining _why_ the reference
is necessary and why it cannot live inside the skill.

## Central registries that stay put

A handful of central files reference Meet by design — they are per-domain
entries in a repo-wide registry, and splitting one entry out into the skill
would break the "one file per domain" pattern the registry relies on. These
are **not** candidates for relocation into `skills/meet-join/`:

- **`assistant/src/daemon/message-types/meet.ts`** — the Meet entry in the
  daemon-client SSE wire-protocol index. Each domain has one file here
  (`apps.ts`, `browser.ts`, `contacts.ts`, etc.), all re-exported from
  `assistant/src/daemon/message-protocol.ts`. Meet's server→client push
  message shapes (e.g. `MeetJoined`, `MeetTranscriptChunk`) live in this
  file alongside every other domain's wire types. This is protocol-level
  surface, not runtime code.

- **`meta/feature-flags/feature-flag-registry.json`** — the central
  declaration of every assistant feature flag, including `meet`. This is
  the canonical flag registry; per-flag entries are not relocated to
  owning skills.

- **`assistant/src/config/schema.ts` /
  `assistant/src/config/schemas/services.ts`** — the central config
  schema composes the per-service schemas, including `MeetService`.

Among these, only files that actually import from `skills/meet-join/` trip
the guard test. `config/schema.ts` and `config/schemas/services.ts` do, so
they're in the allowlist. The message-types file currently does not, but is
allowlisted pre-emptively in case a future change introduces such an import.
The feature-flag registry JSON contains neither substring and is not in the
allowlist.
