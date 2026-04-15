# Meet-join skill — Agent Instructions

All Meet runtime code lives under this directory. The daemon module, tools,
routes, migrations, config schema, wire-contracts, and Meet-bot container
image are all consolidated here so the skill can evolve — or be lifted out of
the repo entirely — without hunting down scattered references across the
monorepo.

## The isolation rule

Code outside `skills/meet-join/` must not import from the skill beyond a small,
explicit allowlist of wiring points: the central tool manifest, HTTP route
mount, workspace migration registry, config schema, daemon shutdown handler,
and the `meet` feature-flag registration. These are the places where a
central registry has to know about Meet — everywhere else, Meet is opaque.

The complete allowlist and enforcement live in
`assistant/src/__tests__/skill-meet-isolation.test.ts`. A guard test scans the
repo for references to `skills/meet-join/` or `@vellumai/meet-contracts` and
fails CI if any non-allowlisted file imports from the skill.

## When you need a new external reference

Before adding a file to the allowlist, check whether the new registration
could instead live inside `skills/meet-join/` and be wired via one of the
existing central hooks. For example, a new tool belongs alongside the
existing ones in `skills/meet-join/tools/` and is surfaced via the existing
entry in `assistant/src/tools/tool-manifest.ts` — no new allowlist entry
required.

If you do need a new external reference (e.g. a new central registry has to
learn about Meet), add the file path to the `ALLOWLIST` in
`skill-meet-isolation.test.ts` with a comment explaining *why* the reference
is necessary and why it cannot live inside the skill.
