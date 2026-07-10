---
name: "llm-cost-optimizer"
description: "Analyze and reduce LLM spend by mapping call-site overrides to managed profiles (Balanced / Quality / Speed). Covers spend analysis, profile assignment, and config correctness."
metadata:
  emoji: "💸"
  vellum:
    category: "development"
    display-name: "LLM Cost Optimizer"
---

## Overview

This skill walks through analyzing and reducing LLM spend on a Vellum assistant. There are three layers:

1. **Provider connections** — named auth configs (e.g. `anthropic-managed`, `my-personal-key`)
2. **Model profiles** — named presets (model + effort + thinking + contextWindow). Three managed defaults: `balanced`, `quality-optimized`, `cost-optimized`.
3. **Call-site overrides** (`llm.callSites.<id>`) — per-task model/profile pinning. Falls back to `llm.default` when absent.

UI labels for the three managed profiles:

- `balanced` → **Balanced** (Sonnet, good for agent loop)
- `quality-optimized` → **Quality** (Opus, for hard tasks)
- `cost-optimized` → **Speed** (Haiku, for utility/background tasks)

### 🚨 Critical: unoverridden call sites fall back to `llm.default`

If `llm.default` is Opus (or any expensive model), **every call site without an explicit override burns that rate**. Don't rely on just patching a few overrides — use the complete turnkey blob in Step 5 to cover every call site at once.

---

## Step 1 — Understand current spend

```bash
# Weekly totals
assistant usage totals --range week

# Break down by call site (most useful — shows what's expensive)
assistant usage breakdown --group-by call_site --range week

# Break down by model
assistant usage breakdown --group-by model --range week

# Break down by profile
assistant usage breakdown --group-by inference_profile --range week
```

Check `llm.default` — if it's pointing at Opus, that's your biggest risk:

```bash
assistant config get llm.default
```

---

## Step 2 — Read current overrides

```bash
assistant config get llm.callSites
assistant config get llm.profiles
assistant inference providers connections list
```

---

## Step 3 — Recommended profile assignment

| Profile                    | Call Sites                                                                                                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `balanced` (Sonnet)        | `mainAgent`, `subagentSpawn`, `compactionAgent`, `patternScan`, `narrativeRefinement`, `memoryConsolidation`, `recall`, `callAgent`, `emptyStateGreeting`, `conversationStarters`, `identityIntro`, `proactiveArtifactBuild` |
| `cost-optimized` (Haiku)   | **Everything else** — `memoryRouter` (with 1M context override), memory extraction/retrieval, UI copy, classifiers, summarization, background tasks                                                                                                 |
| `quality-optimized` (Opus) | **Do not pin.** Reserved for on-demand user escalation via `/model`                                                                                                                                                                                 |

---

## Step 4 — Config gotchas

### ⚠️ JSON object value replaces the entire block

`assistant config set llm.callSites.<key> '{...}'` with a JSON object **replaces the entire `llm.callSites` block**, not just that key.

- ✅ Single leaf value (safe): `assistant config set llm.callSites.mainAgent.profile balanced`
- ✅ Multiple / object values: always set `llm.callSites` as a **single JSON blob** (see Step 5)
- ❌ Never do: `assistant config set llm.callSites.memoryExtraction '{"profile":"cost-optimized"}'` — wipes all other overrides

### ⚠️ Always use profile references — never direct model

❌ Wrong (shows "Custom" with empty provider/model in UI, won't track profile updates):

```bash
assistant config set llm.callSites.memoryExtraction.model claude-haiku-4-5-20251001
```

✅ Correct (shows "Speed" in UI):

```bash
assistant config set llm.callSites.memoryExtraction.profile cost-optimized
```

### Profile + tuning fields can coexist

`profile` sets provider/model/connection. You can still add `effort`, `maxTokens`, `temperature`, `thinking`, `contextWindow` alongside it:

```json
{
  "profile": "cost-optimized",
  "maxTokens": 4096,
  "effort": "low",
  "temperature": 0,
  "thinking": { "enabled": false, "streamThinking": false }
}
```

---

## Step 5 — Apply the complete turnkey blob

This covers **every known call site** — nothing falls back to default. Copy, paste, apply:

> **Note:** The canonical shipped defaults live in `assistant/src/config/call-site-defaults.ts`. The blob below can be used to override a user's config, but call sites without explicit user overrides already resolve to the defaults defined in that file. If new call sites have been added since this skill was written, add them there (default to `cost-optimized` unless they involve reasoning or memory consolidation).

```bash
assistant config set llm.callSites '{
  "mainAgent":                {"profile":"balanced"},
  "subagentSpawn":            {"profile":"balanced"},
  "compactionAgent":          {"profile":"balanced"},
  "patternScan":              {"profile":"balanced"},
  "narrativeRefinement":      {"profile":"balanced"},
  "memoryRouter":             {"profile":"cost-optimized","contextWindow":{"maxInputTokens":1000000}},

  "heartbeatAgent":           {"profile":"cost-optimized","maxTokens":2048,"effort":"low","temperature":0,"thinking":{"enabled":false,"streamThinking":false},"contextWindow":{"maxInputTokens":16000}},
  "filingAgent":              {"profile":"cost-optimized"},
  "callAgent":                {"profile":"balanced"},
  "proactiveArtifactDecision":{"profile":"cost-optimized"},
  "proactiveArtifactBuild":   {"profile":"balanced"},

  "memoryExtraction":         {"profile":"cost-optimized"},
  "memoryConsolidation":      {"profile":"balanced"},
  "memoryRetrieval":          {"profile":"cost-optimized"},
  "memoryRetrospective":      {"profile":"cost-optimized"},
  "recall":                   {"profile":"balanced","maxTokens":4096,"effort":"low","thinking":{"enabled":false,"streamThinking":false},"temperature":0},
  "memoryV2Migration":        {"profile":"cost-optimized"},
  "memoryV2Sweep":            {"profile":"cost-optimized"},
  "memoryV2Consolidation":    {"profile":"balanced"},

  "conversationSummarization":{"profile":"cost-optimized"},
  "commitMessage":            {"profile":"cost-optimized","maxTokens":120,"temperature":0.2,"effort":"low","thinking":{"enabled":false}},

  "conversationStarters":     {"profile":"balanced","effort":"low","thinking":{"enabled":false}},
  "replySuggestion":          {"profile":"cost-optimized","effort":"low","thinking":{"enabled":false}},
  "conversationTitle":        {"profile":"cost-optimized"},
  "identityIntro":            {"profile":"balanced"},
  "emptyStateGreeting":       {"profile":"balanced"},
  "guardianQuestionCopy":     {"profile":"cost-optimized","effort":"low","thinking":{"enabled":false}},
  "approvalCopy":             {"profile":"cost-optimized"},
  "approvalConversation":     {"profile":"cost-optimized"},
  "trustRuleSuggestion":      {"profile":"cost-optimized"},

  "notificationDecision":     {"profile":"cost-optimized","effort":"low","thinking":{"enabled":false}},
  "preferenceExtraction":     {"profile":"cost-optimized","effort":"low","thinking":{"enabled":false}},

  "interactionClassifier":    {"profile":"cost-optimized","effort":"low","thinking":{"enabled":false}},
  "styleAnalyzer":            {"profile":"cost-optimized"},
  "inviteInstructionGenerator":{"profile":"cost-optimized","effort":"low","thinking":{"enabled":false}},
  "skillCategoryInference":   {"profile":"cost-optimized","effort":"low","thinking":{"enabled":false}},
  "meetConsentMonitor":       {"profile":"cost-optimized"},
  "meetChatOpportunity":      {"profile":"cost-optimized"},
  "inference":                {"profile":"cost-optimized"}
}'
```

Then set the **active (default) profile** to `balanced`:

```bash
assistant config set llm.activeProfile balanced
```

This controls what the app shows as the selected profile in the UI, and matters because of a platform quirk: `llm.activeProfile` takes priority over `llm.callSites.mainAgent` in the resolver (inverted vs all other call sites). Setting both to `balanced` keeps them aligned.

Then verify:

```bash
assistant config get llm.callSites
assistant config get llm.activeProfile
```

---

## Step 6 — Escalation path (on-demand Opus)

Don't pin any call site to `quality-optimized`. Keep it available as a session:

```bash
# User types /model quality-optimized in chat, or:
assistant inference session open quality-optimized --ttl 30m
assistant inference session list
assistant inference session close
```

If the user has a personal API key, wire it as a custom profile:

```bash
# Collect the key securely — never paste it in chat
assistant credentials prompt --service anthropic --field api_key \
  --label "Anthropic API Key" --placeholder "sk-ant-..."

assistant inference providers connections create my-anthropic-key \
  --provider anthropic \
  --auth api_key \
  --credential credential/anthropic/api_key

assistant config set llm.profiles.opus-personal '{"provider":"anthropic","model":"claude-opus-4-8","label":"Opus (Personal)","provider_connection":"my-anthropic-key"}'
```

---

## Step 7 — Verify and monitor

```bash
assistant usage totals --range today
assistant usage breakdown --group-by call_site --range today
```

If a specific call site degrades, bump just that one back to `balanced`:

```bash
# e.g. if memory extraction quality drops:
assistant config set llm.callSites.memoryExtraction.profile balanced
```

---

## Reference: provider connections

```bash
assistant inference providers connections list
assistant inference providers connections get <name>
assistant inference providers connections create <name> --provider <p> --auth api_key --credential <vault-key>
assistant inference providers connections update <name> --auth platform
assistant inference providers connections delete <name>
```

Canonical connections seeded on every boot: `anthropic-managed`, `openai-managed`, `gemini-managed` (auth=platform, no key needed).

## Reference: usage breakdown group-by values

`call_site` | `inference_profile` | `model` | `provider` | `conversation` | `actor`

## Reference: usage time ranges

`today` | `week` | `month` | `all` | or explicit `--from`/`--to` epoch-ms
