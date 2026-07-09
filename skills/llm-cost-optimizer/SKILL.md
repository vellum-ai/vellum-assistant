---
name: "llm-cost-optimizer"
description: "Analyze and reduce LLM spend: read usage breakdowns by call site, model, and inference profile, understand single-winner profile resolution, and pin call sites to managed profiles (Balanced / Quality / Speed) only where they should deviate from shipped defaults."
metadata:
  emoji: "💸"
  vellum:
    category: "development"
    display-name: "LLM Cost Optimizer"
---

## Overview

This skill walks through analyzing and reducing LLM spend on a Vellum assistant. There are three layers:

1. **Provider connections** — named auth configs (e.g. `anthropic-managed`, `my-personal-key`)
2. **Model profiles** — named presets (provider + model + effort + thinking + contextWindow). Three managed defaults, with UI labels:
   - `balanced` → **Balanced** (the general agent-loop profile)
   - `quality-optimized` → **Quality** (the expensive escalation profile)
   - `cost-optimized` → **Speed** (the cheap utility/background profile)
3. **Call-site profile pins** (`llm.callSites.<id>.profile`) — optional per-task overrides of the shipped defaults.

The concrete model behind each managed profile depends on the install: platform-managed installs and BYOK installs resolve different providers/models, and the catalog changes over time. **Never assume which model a profile maps to** — read `assistant config get llm.profiles` and the usage breakdown by `model` to see what actually ran.

## How model selection works — read this before diagnosing

Every LLM call resolves exactly **one winning profile** through a strict first-usable-wins chain. Profiles never merge with each other:

1. **Per-conversation / per-run override** — the user's `/model` pick, an open `assistant inference session`, or a schedule's pinned profile
2. **`llm.activeProfile`** — applies to `mainAgent` (the chat loop) **only**; it IS the user's chat-model selection and outranks any `llm.callSites.mainAgent` pin
3. **`llm.callSites.<site>.profile`** — explicit per-site pin
4. **The call site's shipped default intent**, resolved through `llm.defaultProvider`
5. `balanced` intent (final anchor)

A rung only wins if its profile exists, is enabled, and carries its own provider + model; otherwise resolution silently falls to the next rung.

Consequences that change how you diagnose cost:

- **A missing or empty `llm.callSites` block is healthy, not a red flag.** Every call site ships with a sensible default intent: the agent loop and quality-sensitive sites (`mainAgent`, `subagentSpawn`, `compactionAgent`, `callAgent`, `analyzeConversation`, `patternScan`, `narrativeRefinement`, `memoryConsolidation`, `memoryV2Consolidation`, `memoryV3SelectL2`, `recall`, `conversationStarters`, `identityIntro`, `emptyStateGreeting`) default to `balanced`; everything else (classifiers, summarization, titles, copy generation, memory extraction/retrieval/sweeps, heartbeat, home-screen content, etc.) defaults to `cost-optimized`. Nothing "falls back" to an expensive model.
- **Do not write a full `llm.callSites` blob that mirrors the shipped defaults.** That freezes today's defaults into user config and silently opts the user out of future default improvements (and of tuning shipped alongside them, like cache and context-window settings). Pin only deliberate deviations.

## Step 1 — Measure current spend

```bash
# Weekly totals
assistant usage totals --range week

# Break down by call site (what kind of work is expensive)
assistant usage breakdown --group-by call_site --range week

# Break down by model (what actually ran)
assistant usage breakdown --group-by model --range week

# Break down by profile (which selection produced it)
assistant usage breakdown --group-by inference_profile --range week
```

Cross-reference the `call_site` and `inference_profile` breakdowns: a background call site showing spend under an expensive profile means an override or pin routed it there — that is the interesting finding, not the config defaults.

Add `--json` when you need token-level detail (input vs output vs `cache_creation` vs `cache_read`) — high input volume on a cheap model can outweigh low volume on an expensive one.

## Step 2 — Read the effective configuration

```bash
assistant inference callsites list      # per call site: winning profile, default vs pinned
assistant inference profiles list      # effective profiles: managed + user, with availability
assistant inference profiles active    # the chat-model selection
assistant inference providers default  # default provider + availability
assistant inference session list
assistant inference providers connections list
assistant schedules list
```

For each recurring schedule, check which profile its runs use — `assistant schedules get <id>` shows an "Inference profile" line. A schedule with no pinned profile runs under the **mainAgent model selection** (the active profile), not a cheap background profile.

## Step 3 — What typically drives cost (check in this order)

1. **The chat loop and everything that inherits its profile.** `llm.activeProfile` (and per-conversation `/model` sessions) is the #1 lever. Note the inheritance paths: subagents spawned from a conversation with a profile override run under that profile, and memory retrospectives run under the **source conversation's** profile when `memory.retrospective.matchConversationProfile` is enabled (they show under `memoryRetrospective` in the breakdown but are priced at the chat profile — this is deliberate, for prompt-cache reuse).
2. **Recurring schedules without a pinned profile.** Schedule runs default to the mainAgent model selection, and a pinned schedule profile overrides the *entire run* (every call site in it). A frequent schedule left on an expensive chat profile is a classic silent cost driver — check it with `assistant usage breakdown --group-by call_site --schedule <id>`, and per-run cost with `assistant schedules runs <id>`.
3. **Pins to `quality-optimized`.** No call site should be statically pinned to it; it is an on-demand escalation profile.
4. **High-volume background sites.** `memoryRouter` runs with a very large input window by design; heartbeat, memory sweeps, and summarization run often. These are already on `cost-optimized` by default — check whether a pin or override moved them off it.
5. **Cache economics.** Repeated-prefix call sites benefit from caching; one-shot sites ship with caching disabled. If `cache_creation` dwarfs `cache_read` on a site, flag it.

## Step 4 — Optimize

- **Chat model**: if the user is happy to reduce chat cost, set the active profile — this is the same thing the model picker in the UI writes:

  ```bash
  assistant config set llm.activeProfile balanced
  ```

- **Downgrade one specific site** that the breakdown shows is expensive and quality-insensitive (leaf path, see Step 5):

  ```bash
  assistant config set llm.callSites.memoryExtraction.profile cost-optimized
  ```

- **Restore a site to its shipped default** by clearing the pin:

  ```bash
  assistant config set llm.callSites.memoryExtraction null
  ```

- **Verify any pin change** with `assistant inference callsites get <site>` — it shows the effective resolution chain, so you can confirm the pin actually took (or that clearing it restored the shipped default).

- **Schedules**: pin frequent background schedules to a cheap profile, or clear a stale expensive pin:

  ```bash
  assistant schedules update <id> --profile cost-optimized
  assistant schedules update <id> --clear-profile   # revert to the mainAgent model selection
  ```

  (`--profile` is also available on `assistant schedules create`.) Reserve the default (chat-profile) behavior for schedules whose output quality the user actually reads.

- **Never pin `quality-optimized`.** Keep it for on-demand escalation (Step 6).

## Step 5 — Config write safety

- **Prefer single leaf paths** (`llm.callSites.<site>.profile <value>`). They are surgical and cannot clobber siblings.
- **Object values replace the whole subtree at that path** (siblings are preserved). `assistant config set llm.callSites.mainAgent '{"profile":"balanced"}'` replaces mainAgent's entire fragment — including any tuning fields that were set — but does not touch other call sites.
- **Writes are not schema-validated at write time.** A typo'd call-site name, profile name, or field lands in config silently; a bad profile reference just falls through to the shipped default at resolution time, so the "pin" does nothing without an error. After every write, re-read the key (`assistant config get ...`) and pick names from `assistant inference callsites list` / `assistant inference profiles list` output.
- **Always use profile references, never direct `model` values** on call sites. A direct model shows as "Custom" in the UI, detaches from managed profile updates, and couples config to a model id that will go stale.
- `profile` plus tuning fields can coexist on a pin: `effort`, `maxTokens`, `temperature`, `thinking`, `contextWindow` all layer on top of the winning profile.

## Step 6 — Escalation path (on-demand Quality)

Don't pin any call site to `quality-optimized`. Escalate per conversation:

```bash
# User picks Quality in the model picker, types /model in chat, or:
assistant inference session open quality-optimized --ttl 30m
assistant inference session list
assistant inference session close
```

For the full setup procedure (managed-first, secure key collection, model discovery, validation), load the **llm-provider-setup** skill.

If the user wants a custom profile on a specific provider, work down this ladder — do not start by asking for a key:

1. **Check for a managed connection first.** `assistant inference providers connections list` — managed entries (`auth=platform`, e.g. `anthropic-managed`) need no API key. If one covers the target provider, create the profile against it and skip the rest of this ladder.
2. **Check for an existing stored key.** `assistant credentials list` — if a suitable credential is already in the vault, reference it by vault path instead of prompting for a new one.
3. **Only then collect a new key — securely, never in chat:**

```bash
assistant credentials prompt --service anthropic --field api_key \
  --label "Anthropic API Key" --placeholder "sk-ant-..."

assistant inference providers connections create my-anthropic-key \
  --provider anthropic \
  --auth api_key \
  --credential credential/anthropic/api_key

assistant inference profiles create my-quality \
  --provider anthropic --model <model-id-from: assistant inference models list --provider anthropic> \
  --connection my-anthropic-key --label "Quality (Personal)"
```

### Always validate a new profile or connection with a live call

Model ids are easy to get wrong and config writes are not validated (Step 5), so after creating or editing any profile or connection, prove it works end-to-end before relying on it:

```bash
assistant inference send --profile my-quality --max-tokens 32 --json "Reply with OK"
```

This makes one real call through the named profile — auth, provider routing, and the model id are all exercised; a wrong model name fails here instead of silently breaking a call site later. To check a raw model id *before* writing it into config, use `--model <id>` instead of `--profile`.

## Step 7 — Verify and monitor

```bash
assistant usage totals --range today
assistant usage breakdown --group-by call_site --range today
assistant usage breakdown --group-by inference_profile --range today
```

If a specific call site's output quality degrades after a downgrade, restore just that one:

```bash
assistant config set llm.callSites.memoryExtraction.profile balanced
```

## Reference: provider connections

```bash
assistant inference providers connections list
assistant inference providers connections get <name>
assistant inference providers connections create <name> --provider <p> --auth api_key --credential <vault-key>
assistant inference providers connections update <name> --auth platform
assistant inference providers connections delete <name>
```

Canonical managed connections are seeded automatically (auth=platform, no key needed).

## Reference: inference profiles & call sites

```bash
assistant inference models list --provider <p>   # valid model ids — never guess
assistant inference callsites list / get <site>
assistant inference profiles list / get / create / update / delete / active
assistant inference providers default
```

## Reference: schedule profile commands

```bash
assistant schedules list
assistant schedules get <id>                          # shows the schedule's inference profile
assistant schedules runs <id>                         # recent runs
assistant schedules create <name> ... --profile <p>   # pin at creation
assistant schedules update <id> --profile <p>         # pin an existing schedule
assistant schedules update <id> --clear-profile       # revert to the mainAgent model selection
```

## Reference: usage breakdown group-by values

`call_site` | `inference_profile` | `model` | `provider` | `conversation` | `actor`

## Reference: usage time ranges

`today` | `week` | `month` | `all` | or explicit `--from`/`--to` epoch-ms

`--schedule <id>` filters `usage totals` / `daily` / `breakdown` to a single schedule's runs.
