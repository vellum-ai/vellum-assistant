import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Consolidate scattered LLM-related config keys into the unified `llm` block
 * introduced in PR 1 of the LLM call-site unification plan.
 *
 * What this migration writes (under `llm.*`):
 *   - `llm.default` — provider/model/maxTokens/effort/speed/thinking/contextWindow
 *     pulled from `services.inference.{provider,model}` and the legacy
 *     top-level `maxTokens`/`effort`/`speed`/`thinking`/`contextWindow` keys.
 *     `temperature` is seeded as `null` because no current config source maps to
 *     it.
 *   - `llm.callSites.<id>` — per-call-site overrides derived from the existing
 *     scattered config (`heartbeat.speed`, `filing.speed`,
 *     `analysis.modelIntent`/`modelOverride`,
 *     `memory.summarization.modelIntent`,
 *     `workspaceGit.commitMessageLLM.{maxTokens,temperature}`,
 *     `ui.greetingModelIntent`, `notifications.decisionModelIntent` (which
 *     drives both `notificationDecision` and `preferenceExtraction`),
 *     `calls.model`).
 *   - `llm.pricingOverrides` — copied from the top-level `pricingOverrides`.
 *
 * What this migration does NOT do:
 *   - Delete any of the source keys. The legacy keys remain on disk so
 *     existing readers continue to work. PR 19 of the plan removes them from
 *     the schema once every call site has been switched over to read through
 *     the resolver.
 *
 * Idempotency:
 *   - Early-returns when `config.llm.default` is already present, so re-runs
 *     and runs against an already-migrated workspace are no-ops.
 *   - Early-returns on missing/malformed `config.json`.
 *
 * Rollback (`down`):
 *   - Reverses the mapping best-effort by extracting `llm.default.*` back to
 *     top-level + `services.inference`, extracting `llm.callSites.*` back to
 *     scattered keys, copying `llm.pricingOverrides` back to top-level
 *     `pricingOverrides`, and finally removing `llm`. After PRs 7-18 land and
 *     callers stop reading the old keys, rollback fidelity will degrade
 *     (callers will only see what `down` writes back), which is acceptable
 *     for a development rollback path.
 */
export const unifyLlmCallSiteConfigsMigration: WorkspaceMigration = {
  id: "038-unify-llm-callsite-configs",
  description:
    "Consolidate scattered LLM config keys into unified llm.{default,profiles,callSites} structure",
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) return;

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    // Idempotency: skip only when `llm.default` is present AND no legacy
    // source key remains on disk. The `&& !hasLegacyData` clause matters
    // because `AssistantConfigSchema` wires `llm: LLMSchema.default(LLMSchema
    // .parse({}))`, which makes `loadConfig()` inject a full schema-default
    // `llm.default` block to disk on first daemon boot under the new schema.
    // If that boot happened before this migration was added (or before the
    // daemon binary that includes it landed on the user's machine),
    // `llm.default` will be present BUT will hold schema defaults rather
    // than the user's actual `services.inference.{provider, model}` values.
    // Returning early here would let migration 039 strip the legacy keys
    // silently, dropping the user's real configuration.
    const existingLlm = readObject(config.llm);
    const existingDefault = existingLlm
      ? readObject(existingLlm.default)
      : null;
    const hasLegacyData =
      hasLegacyLlmDefaultSource(config) || hasLegacyCallSiteSource(config);
    if (existingDefault !== null && !hasLegacyData) {
      return;
    }

    // ── Build llm.default ──────────────────────────────────────────────
    // Precedence (highest wins): legacy source key → existing `llm.default`
    // value → migration fallback. Existing values come second so that on a
    // re-run AFTER legacy keys are stripped, user-set `llm.default.*` values
    // survive untouched (the early-return above handles the common no-op
    // path; this ordering covers the partial-state case).
    const services = readObject(config.services) ?? {};
    const inference = readObject(services.inference) ?? {};

    const defaultBlock: Record<string, unknown> = {
      provider:
        readString(inference.provider) ??
        readString(config.provider) ??
        readString(existingDefault?.provider) ??
        "anthropic",
      model:
        readString(inference.model) ??
        readString(config.model) ??
        readString(existingDefault?.model) ??
        "claude-opus-4-6",
      maxTokens:
        readPositiveInt(config.maxTokens) ??
        readPositiveInt(existingDefault?.maxTokens) ??
        64000,
      effort:
        readEnum(config.effort, EFFORT_VALUES) ??
        readEnum(existingDefault?.effort, EFFORT_VALUES) ??
        "max",
      speed:
        readEnum(config.speed, SPEED_VALUES) ??
        readEnum(existingDefault?.speed, SPEED_VALUES) ??
        "standard",
      // No current legacy key maps to temperature; preserve existing
      // `llm.default.temperature` if a user set one, else seed null to
      // match `LLMConfigBase` defaults.
      temperature:
        existingDefault && "temperature" in existingDefault
          ? (existingDefault.temperature as number | null)
          : null,
    };
    const thinking =
      readObject(config.thinking) ??
      (existingDefault ? readObject(existingDefault.thinking) : null);
    if (thinking !== null) {
      defaultBlock.thinking = thinking;
    }
    const contextWindow =
      readObject(config.contextWindow) ??
      (existingDefault ? readObject(existingDefault.contextWindow) : null);
    if (contextWindow !== null) {
      defaultBlock.contextWindow = contextWindow;
    }

    // ── Build llm.callSites ────────────────────────────────────────────
    const callSites: Record<string, Record<string, unknown>> = {};

    const heartbeat = readObject(config.heartbeat);
    const heartbeatSpeed = heartbeat
      ? readEnum(heartbeat.speed, SPEED_VALUES)
      : undefined;
    if (heartbeatSpeed !== undefined && heartbeatSpeed !== defaultBlock.speed) {
      callSites.heartbeatAgent = { speed: heartbeatSpeed };
    }

    const filing = readObject(config.filing);
    const filingSpeed = filing
      ? readEnum(filing.speed, SPEED_VALUES)
      : undefined;
    if (filingSpeed !== undefined && filingSpeed !== defaultBlock.speed) {
      callSites.filingAgent = { speed: filingSpeed };
    }

    const analysis = readObject(config.analysis);
    if (analysis !== null) {
      const analysisOverride = readString(analysis.modelOverride);
      const analysisIntent = readModelIntent(analysis.modelIntent);
      const analysisCallSite: Record<string, unknown> = {};
      // `modelOverride` is shaped as `"provider/model"` — explode into the
      // resolver's separate provider/model fields. If the string lacks a
      // slash, treat the whole value as the model and inherit the active
      // provider implicitly via the resolver's default merge.
      if (analysisOverride !== undefined) {
        const [providerPart, ...modelParts] = analysisOverride.split("/");
        if (modelParts.length > 0 && providerPart.length > 0) {
          analysisCallSite.provider = providerPart;
          analysisCallSite.model = modelParts.join("/");
        } else {
          analysisCallSite.model = analysisOverride;
        }
      } else if (analysisIntent !== undefined) {
        // Resolve intent to provider/model using the same lookup the runtime
        // uses (mirrors `providers/model-intents.ts` PROVIDER_MODEL_INTENTS).
        const provider = String(defaultBlock.provider);
        const resolvedModel = resolveModelIntentForProvider(
          provider,
          analysisIntent,
        );
        if (resolvedModel !== undefined) {
          analysisCallSite.model = resolvedModel;
        }
      }
      if (Object.keys(analysisCallSite).length > 0) {
        callSites.analyzeConversation = analysisCallSite;
      }
    }

    const memory = readObject(config.memory);
    const summarization = memory ? readObject(memory.summarization) : null;
    const summarizationIntent = summarization
      ? readModelIntent(summarization.modelIntent)
      : undefined;
    if (summarizationIntent !== undefined) {
      const provider = String(defaultBlock.provider);
      const resolvedModel = resolveModelIntentForProvider(
        provider,
        summarizationIntent,
      );
      if (resolvedModel !== undefined) {
        callSites.conversationSummarization = { model: resolvedModel };
      }
    }

    const workspaceGit = readObject(config.workspaceGit);
    const commitMessageLLM = workspaceGit
      ? readObject(workspaceGit.commitMessageLLM)
      : null;
    if (commitMessageLLM !== null) {
      const commitOverride: Record<string, unknown> = {};
      const cmMaxTokens = readPositiveInt(commitMessageLLM.maxTokens);
      if (cmMaxTokens !== undefined) {
        commitOverride.maxTokens = cmMaxTokens;
      }
      const cmTemperature = readTemperature(commitMessageLLM.temperature);
      if (cmTemperature !== undefined) {
        commitOverride.temperature = cmTemperature;
      }
      if (Object.keys(commitOverride).length > 0) {
        callSites.commitMessage = commitOverride;
      }
    }

    const ui = readObject(config.ui);
    const greetingIntent = ui
      ? readModelIntent(ui.greetingModelIntent)
      : undefined;
    if (greetingIntent !== undefined) {
      const provider = String(defaultBlock.provider);
      const resolvedModel = resolveModelIntentForProvider(
        provider,
        greetingIntent,
      );
      if (resolvedModel !== undefined) {
        callSites.emptyStateGreeting = { model: resolvedModel };
      }
    }

    const notifications = readObject(config.notifications);
    const notificationIntent = notifications
      ? readModelIntent(notifications.decisionModelIntent)
      : undefined;
    if (notificationIntent !== undefined) {
      const provider = String(defaultBlock.provider);
      const resolvedModel = resolveModelIntentForProvider(
        provider,
        notificationIntent,
      );
      if (resolvedModel !== undefined) {
        // `notifications.decisionModelIntent` drives BOTH the notification
        // decision engine (`notifications/decision-engine.ts`) AND the
        // preference extractor (`notifications/preference-extractor.ts`), so
        // seed both call sites from the same source intent. Confirmed via
        // grep — those are the only two readers of the legacy key.
        callSites.notificationDecision = { model: resolvedModel };
        callSites.preferenceExtraction = { model: resolvedModel };
      }
    }

    const calls = readObject(config.calls);
    const callsModel = calls ? readString(calls.model) : undefined;
    if (callsModel !== undefined) {
      callSites.callAgent = { model: callsModel };
    }

    // ── Build llm block ────────────────────────────────────────────────
    //
    // Preserve any pre-existing `llm` subtree. Reaching this point means
    // `llm.default` was absent (idempotency check at the top), but a user
    // may still have defined `llm.callSites`, `llm.profiles`, or
    // `llm.pricingOverrides` directly. Wholesale-replacing `config.llm`
    // would silently drop those user overrides, so deep-merge instead:
    //   - `default`: always taken from this migration (we just synthesized
    //     it from legacy keys).
    //   - `callSites`: per-key merge, with migration-derived entries
    //     overwriting pre-existing entries that share the same key.
    //   - `profiles`: preserved verbatim from existing `llm.profiles`.
    //   - `pricingOverrides`: prefer the migration-derived value (legacy
    //     top-level `pricingOverrides`); fall back to existing
    //     `llm.pricingOverrides` if the legacy key is absent.
    const llmBlock: Record<string, unknown> = {
      default: defaultBlock,
    };
    const existingProfiles = existingLlm
      ? readObject(existingLlm.profiles)
      : null;
    if (existingProfiles !== null) {
      llmBlock.profiles = existingProfiles;
    }
    const existingCallSites = existingLlm
      ? readObject(existingLlm.callSites)
      : null;
    const mergedCallSites: Record<string, Record<string, unknown>> = {};
    if (existingCallSites !== null) {
      for (const [key, value] of Object.entries(existingCallSites)) {
        const obj = readObject(value);
        if (obj !== null) {
          mergedCallSites[key] = obj;
        }
      }
    }
    for (const [key, value] of Object.entries(callSites)) {
      mergedCallSites[key] = value;
    }
    if (Object.keys(mergedCallSites).length > 0) {
      llmBlock.callSites = mergedCallSites;
    }
    const pricingOverrides = config.pricingOverrides;
    if (Array.isArray(pricingOverrides)) {
      llmBlock.pricingOverrides = pricingOverrides;
    } else if (existingLlm && Array.isArray(existingLlm.pricingOverrides)) {
      llmBlock.pricingOverrides = existingLlm.pricingOverrides;
    }

    config.llm = llmBlock;

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  /**
   * Documented no-op since PR 19 of the unify-llm-callsites plan.
   *
   * The legacy keys that this migration consolidates (`services.inference.
   * {provider,model}`, top-level `maxTokens`/`effort`/`speed`/`thinking`/
   * `contextWindow`/`pricingOverrides`, `heartbeat.speed`, `filing.speed`,
   * `analysis.modelIntent`/`modelOverride`, `memory.summarization.modelIntent`,
   * `notifications.decisionModelIntent`, `ui.greetingModelIntent`,
   * `calls.model`, and `workspaceGit.commitMessageLLM.{maxTokens,temperature}`)
   * were removed from `AssistantConfigSchema` in PR 19. Re-creating them in
   * `down()` would have no effect on the running daemon (no code reads them
   * any more), so a rollback that needs to undo this migration must instead
   * roll back the application binary to a build that predates PR 19.
   */
  down(_workspaceDir: string): void {
    // Forward-only after PR 19. See comment above.
  },
};

// ---------------------------------------------------------------------------
// Helpers — self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

// `xhigh` was added to the runtime enum in main PR #26117 after this
// migration was authored. Widening the validation set is safe (it can only
// admit MORE legitimate values, never narrow them) and prevents an `effort:
// "xhigh"` legacy value from being silently downgraded to "max" during the
// consolidation below.
const EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh", "max"]);
const SPEED_VALUES = new Set(["standard", "fast"]);
const MODEL_INTENT_VALUES = new Set([
  "latency-optimized",
  "quality-optimized",
  "vision-optimized",
]);

/**
 * Mirror of `providers/model-intents.ts:PROVIDER_MODEL_INTENTS` snapshotted at
 * the time this migration was authored. Migrations are write-once and must be
 * self-contained — duplicating the table here means the migration's behavior
 * is frozen against the catalog as it existed when users upgraded across this
 * boundary, even if the runtime catalog evolves later.
 */
const PROVIDER_MODEL_INTENTS_SNAPSHOT: Record<
  string,
  Record<string, string>
> = {
  anthropic: {
    "latency-optimized": "claude-haiku-4-5-20251001",
    "quality-optimized": "claude-opus-4-7",
    "vision-optimized": "claude-opus-4-6",
  },
  openai: {
    "latency-optimized": "gpt-5.4-nano",
    "quality-optimized": "gpt-5.4",
    "vision-optimized": "gpt-5.4",
  },
  gemini: {
    "latency-optimized": "gemini-3-flash",
    "quality-optimized": "gemini-3-flash",
    "vision-optimized": "gemini-3-flash",
  },
  ollama: {
    "latency-optimized": "llama3.2",
    "quality-optimized": "llama3.2",
    "vision-optimized": "llama3.2",
  },
  fireworks: {
    "latency-optimized": "accounts/fireworks/models/kimi-k2p5",
    "quality-optimized": "accounts/fireworks/models/kimi-k2p5",
    "vision-optimized": "accounts/fireworks/models/kimi-k2p5",
  },
  openrouter: {
    "latency-optimized": "anthropic/claude-haiku-4.5",
    "quality-optimized": "anthropic/claude-opus-4.7",
    "vision-optimized": "anthropic/claude-opus-4.6",
  },
};

function resolveModelIntentForProvider(
  provider: string,
  intent: string,
): string | undefined {
  return PROVIDER_MODEL_INTENTS_SNAPSHOT[provider]?.[intent];
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function readEnum<T extends string>(
  value: unknown,
  allowed: Set<string>,
): T | undefined {
  return typeof value === "string" && allowed.has(value)
    ? (value as T)
    : undefined;
}

function readModelIntent(value: unknown): string | undefined {
  return typeof value === "string" && MODEL_INTENT_VALUES.has(value)
    ? value
    : undefined;
}

function readTemperature(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 2
    ? value
    : undefined;
}

/**
 * Returns true if any source key that this migration consolidates into
 * `llm.default` is still present on disk. The `provider`/`model`/etc. checks
 * cover the `services.inference` and top-level legacy locations; their
 * presence proves migration 039 hasn't yet stripped them, which means we
 * MUST re-process even if `llm.default` already exists (it may have been
 * injected by `loadConfig()`'s schema-default backfill rather than by a
 * previous run of this migration).
 */
function hasLegacyLlmDefaultSource(config: Record<string, unknown>): boolean {
  const services = readObject(config.services);
  const inference = services ? readObject(services.inference) : null;
  if (
    inference &&
    (readString(inference.provider) !== undefined ||
      readString(inference.model) !== undefined)
  ) {
    return true;
  }
  for (const key of [
    "provider",
    "model",
    "maxTokens",
    "effort",
    "speed",
    "thinking",
    "contextWindow",
    "pricingOverrides",
  ]) {
    if (key in config) return true;
  }
  return false;
}

/**
 * Returns true if any source key that this migration consolidates into
 * `llm.callSites` is still present on disk. Same idempotency justification
 * as `hasLegacyLlmDefaultSource`: their presence proves migration 039
 * hasn't yet stripped them and re-processing is required.
 */
function hasLegacyCallSiteSource(config: Record<string, unknown>): boolean {
  const heartbeat = readObject(config.heartbeat);
  if (heartbeat && "speed" in heartbeat) return true;
  const filing = readObject(config.filing);
  if (filing && "speed" in filing) return true;
  const analysis = readObject(config.analysis);
  if (analysis && ("modelIntent" in analysis || "modelOverride" in analysis)) {
    return true;
  }
  const memory = readObject(config.memory);
  const summarization = memory ? readObject(memory.summarization) : null;
  if (summarization && "modelIntent" in summarization) return true;
  const notifications = readObject(config.notifications);
  if (notifications && "decisionModelIntent" in notifications) return true;
  const ui = readObject(config.ui);
  if (ui && "greetingModelIntent" in ui) return true;
  const calls = readObject(config.calls);
  if (calls && "model" in calls) return true;
  const workspaceGit = readObject(config.workspaceGit);
  const commitMessageLLM = workspaceGit
    ? readObject(workspaceGit.commitMessageLLM)
    : null;
  if (
    commitMessageLLM &&
    ("maxTokens" in commitMessageLLM || "temperature" in commitMessageLLM)
  ) {
    return true;
  }
  return false;
}
