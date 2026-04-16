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

    // Idempotency: if `llm.default` already present, the workspace has
    // already been migrated.
    const existingLlm = readObject(config.llm);
    if (existingLlm !== null && readObject(existingLlm.default) !== null) {
      return;
    }

    // ── Build llm.default ──────────────────────────────────────────────
    const services = readObject(config.services) ?? {};
    const inference = readObject(services.inference) ?? {};

    const defaultBlock: Record<string, unknown> = {
      provider:
        readString(inference.provider) ??
        readString(config.provider) ??
        "anthropic",
      model:
        readString(inference.model) ??
        readString(config.model) ??
        "claude-opus-4-6",
      maxTokens: readPositiveInt(config.maxTokens) ?? 64000,
      effort: readEnum(config.effort, EFFORT_VALUES) ?? "max",
      speed: readEnum(config.speed, SPEED_VALUES) ?? "standard",
      // No current config key maps to temperature — seed null to match
      // `LLMConfigBase` defaults.
      temperature: null,
    };
    const thinking = readObject(config.thinking);
    if (thinking !== null) {
      defaultBlock.thinking = thinking;
    }
    const contextWindow = readObject(config.contextWindow);
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
  down(workspaceDir: string): void {
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

    const llm = readObject(config.llm);
    if (llm === null) return;

    // ── Reverse llm.default → top-level + services.inference ──────────
    const defaultBlock = readObject(llm.default);
    if (defaultBlock !== null) {
      const services = ensureObj(config, "services");
      const inference = ensureObj(services, "inference");
      const provider = readString(defaultBlock.provider);
      if (provider !== undefined) {
        inference.provider = provider;
      }
      const model = readString(defaultBlock.model);
      if (model !== undefined) {
        inference.model = model;
      }
      const maxTokens = readPositiveInt(defaultBlock.maxTokens);
      if (maxTokens !== undefined) {
        config.maxTokens = maxTokens;
      }
      const effort = readEnum(defaultBlock.effort, EFFORT_VALUES);
      if (effort !== undefined) {
        config.effort = effort;
      }
      const speed = readEnum(defaultBlock.speed, SPEED_VALUES);
      if (speed !== undefined) {
        config.speed = speed;
      }
      const thinking = readObject(defaultBlock.thinking);
      if (thinking !== null) {
        config.thinking = thinking;
      }
      const contextWindow = readObject(defaultBlock.contextWindow);
      if (contextWindow !== null) {
        config.contextWindow = contextWindow;
      }
    }

    // ── Reverse llm.callSites → scattered keys ────────────────────────
    const callSites = readObject(llm.callSites) ?? {};

    const heartbeatAgent = readObject(callSites.heartbeatAgent);
    if (heartbeatAgent !== null) {
      const speed = readEnum(heartbeatAgent.speed, SPEED_VALUES);
      if (speed !== undefined) {
        const heartbeat = ensureObj(config, "heartbeat");
        heartbeat.speed = speed;
      }
    }

    const filingAgent = readObject(callSites.filingAgent);
    if (filingAgent !== null) {
      const speed = readEnum(filingAgent.speed, SPEED_VALUES);
      if (speed !== undefined) {
        const filing = ensureObj(config, "filing");
        filing.speed = speed;
      }
    }

    const analyzeConversation = readObject(callSites.analyzeConversation);
    if (analyzeConversation !== null) {
      const provider = readString(analyzeConversation.provider);
      const model = readString(analyzeConversation.model);
      const recombined =
        provider !== undefined && model !== undefined
          ? `${provider}/${model}`
          : (model ?? undefined);
      if (recombined !== undefined) {
        const analysis = ensureObj(config, "analysis");
        analysis.modelOverride = recombined;
      }
    }

    const callAgent = readObject(callSites.callAgent);
    if (callAgent !== null) {
      const model = readString(callAgent.model);
      if (model !== undefined) {
        const calls = ensureObj(config, "calls");
        calls.model = model;
      }
    }

    const commitMessage = readObject(callSites.commitMessage);
    if (commitMessage !== null) {
      const cmMaxTokens = readPositiveInt(commitMessage.maxTokens);
      const cmTemperature = readTemperature(commitMessage.temperature);
      if (cmMaxTokens !== undefined || cmTemperature !== undefined) {
        const workspaceGit = ensureObj(config, "workspaceGit");
        const commitMessageLLM = ensureObj(workspaceGit, "commitMessageLLM");
        if (cmMaxTokens !== undefined) {
          commitMessageLLM.maxTokens = cmMaxTokens;
        }
        if (cmTemperature !== undefined) {
          commitMessageLLM.temperature = cmTemperature;
        }
      }
    }
    // Note: `conversationSummarization`, `emptyStateGreeting`,
    // `notificationDecision`, and `preferenceExtraction` were derived from
    // `modelIntent` keys — `down()` intentionally does not synthesize a
    // reverse intent (we only have a resolved model, not the intent that
    // produced it). Callers reading those legacy keys after a rollback will
    // fall back to schema defaults.

    // ── Reverse llm.pricingOverrides → top-level pricingOverrides ─────
    if (Array.isArray(llm.pricingOverrides)) {
      config.pricingOverrides = llm.pricingOverrides;
    }

    delete config.llm;

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
};

// ---------------------------------------------------------------------------
// Helpers — self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

const EFFORT_VALUES = new Set(["low", "medium", "high", "max"]);
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

function ensureObj(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  if (
    !(key in parent) ||
    parent[key] == null ||
    typeof parent[key] !== "object" ||
    Array.isArray(parent[key])
  ) {
    parent[key] = {};
  }
  return parent[key] as Record<string, unknown>;
}
