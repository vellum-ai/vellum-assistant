# Meet-join skill — Agent Instructions

All Meet runtime code lives under this directory. The daemon module, tools,
routes, config schema, wire-contracts, and Meet-bot container image are all
consolidated here so the skill can evolve — or be lifted out of the repo
entirely — without hunting down scattered references across the monorepo.

## The isolation rule

The `assistant/` module must never import from `skills/meet-join/` via
relative paths, and `skills/meet-join/` must never import from `assistant/`.
Both directions are enforced by `assistant/src/__tests__/skill-boundary-guard.test.ts`.

Meet-join runs as a separate `bun run` subprocess. The daemon ships
this directory's source plus a generated `manifest.json` alongside its
binary; on startup it installs proxy tools/routes/hooks from the manifest
and spawns the meet-host child on first invocation via the
`assistant-skill.sock` IPC socket. See `assistant/src/daemon/meet-host-startup.ts`
and `assistant/src/daemon/meet-host-supervisor.ts` for the daemon side.

Skills wire into the assistant through the `SkillHost` contract from
`@vellumai/skill-host-contracts`. The meet-host entrypoint constructs a
`SkillHostClient` against the IPC socket and passes it to `register(host)`;
the skill uses `host.registries.*` instead of direct imports from `assistant/`:

- **Tools**: `host.registries.registerTools(() => [...])`
- **Routes**: `host.registries.registerSkillRoute({ pattern, methods, handler })`
- **Shutdown**: `host.registries.registerShutdownHook(name, hook)`

Sub-modules (`audio-ingest`, `speaker-resolver`, `tts-bridge`, …)
expose host-accepting factories and register them into
`daemon/modules-registry.ts`. The session manager resolves those
factories by name through `getSubModule`, so adding a new sub-module
does not require editing `register.ts`.

The meet skill owns its config schema (`config-schema.ts`) and reads its
configuration from `<workspace>/config/meet.json` via `meet-config.ts`. The
workspace directory is supplied by the caller (`host.platform.workspaceDir()`
in production). The assistant's global `config.json` does not contain meet
configuration.

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

## Browser control: the extension package (`meet-controller-ext/`)

Browser-side Meet control lives in the sibling `meet-controller-ext/`
package, NOT in `bot/`. The bot launches google-chrome-stable as a plain
subprocess with `--load-extension=/app/ext` (where `/app/ext` is the
built output of `meet-controller-ext/`). Bot ↔ extension communication
flows through Chrome Native Messaging over a Unix socket owned by the
bot process.

**Rationale**: Playwright-driven Chrome is detected by Meet's BotGuard;
we use a real Chrome subprocess with a bundled extension instead. Any
attempt to reintroduce CDP (`--remote-debugging-port`,
`--enable-automation`, Playwright, Puppeteer) will fail at the Meet
prejoin surface. See `.private/plans/archived/meet-phase-1-11-chrome-extension.md`
for the empirical repro.

**Where each piece lives**:

- `meet-controller-ext/src/features/` — in-page logic: `join.ts`,
  `participants.ts`, `speaker.ts`, `chat.ts`.
- `meet-controller-ext/src/dom/` — Meet DOM selectors + wait helpers,
  with fixture-backed tests under `src/dom/__tests__/`.
- `meet-controller-ext/src/messaging/` — extension-side transport to
  the bot's native messaging host.
- `bot/src/native-messaging/` — bot-side socket server + NMH shim.
- `contracts/native-messaging.ts` — zod-validated wire protocol for
  `BotToExtensionMessage` / `ExtensionToBotMessage`.

Do not re-introduce Playwright or any CDP-based automation library into
`bot/`. See `bot/AGENTS.md` for the bot-side architecture.

## Release gating

The `meet` feature flag defaults to **off** in
`meta/feature-flags/feature-flag-registry.json`. Turning it on in
production requires both of the following to be true:

1. All Blocking and Important PRs in the Phase 1.12 plan have landed on
   `main` and been live-verified (no regressions against a real Meet).
2. The LaunchDarkly provisioning PR in `vellum-assistant-platform` has
   merged, creating the Terraform entry for `meet` so the platform can
   remote-sync the flag to managed assistants. This companion PR is
   tracked in `meta/feature-flags/PENDING_PLATFORM_PRS.md` — the entry
   there should be removed once the platform PR lands.

Until both conditions are met, the flag must stay off for all users
outside the local development environment.
