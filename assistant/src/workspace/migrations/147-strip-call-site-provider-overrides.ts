import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("migrations/147-strip-call-site-provider-overrides");

// Call-site overrides are model-only: a tweak picks a model (and tuning),
// and the route (provider, connection, billing) always comes from the
// winning profile. This migration reconciles stored config with that
// contract.
//
// Rules per `llm.callSites.<site>`:
// - `provider` is deleted verbatim (schema-dead: every `LLMSchema` parse
//   strips it). Any stray `provider_connection` is deleted too: an
//   idempotent re-sweep of migration 133's rule, never a rewrite signal.
// - A `model` stays when the site's winning route can serve it; otherwise
//   the WHOLE tweak is deleted with a structured warn, since a model the route
//   cannot serve would fail every request on that call site.
// - An entry left `{}` is deleted entirely: a present-but-empty tweak
//   suppresses the shipped call-site default (the loader's recovery pass
//   prunes emptied entries for the same reason).
//
// The winning route is approximated with the resolver's selection chain
// (activeProfile for mainAgent, the site's profile pin, then the shipped
// default intent through `llm.defaultProvider`), judged against frozen
// snapshots of the routing tables and provider catalog as of 2026-08-20.
// Every indeterminable case (mix winners, unknown profiles, unreadable
// connection rows, providers whose model set is not code-known) keeps the
// model (fail-open).

// Frozen snapshot: the default profile keys that resolve through the
// intent x provider matrix even without a workspace entry.
const DEFAULT_PROFILE_KEYS = new Set([
  "balanced",
  "quality-optimized",
  "cost-optimized",
  "latency-optimized",
]);

// Frozen snapshot of CALL_SITE_DEFAULTS profile intents (sites absent here,
// e.g. vision/workflowLeaf, anchor on the balanced intent).
const SHIPPED_CALL_SITE_INTENTS: Record<string, string> = {
  mainAgent: "balanced",
  subagentSpawn: "balanced",
  compactionAgent: "balanced",
  patternScan: "balanced",
  narrativeRefinement: "balanced",
  callAgent: "balanced",
  memoryConsolidation: "balanced",
  identityIntro: "balanced",
  emptyStateGreeting: "balanced",
  memoryV3SelectL2: "balanced",
  recall: "balanced",
  conversationStarters: "balanced",
  memoryV2Consolidation: "balanced",
  memoryRouter: "cost-optimized",
  filingAgent: "cost-optimized",
  memoryExtraction: "cost-optimized",
  memoryRetrieval: "cost-optimized",
  memoryRetrospective: "cost-optimized",
  memoryV2Migration: "cost-optimized",
  memoryV2Sweep: "cost-optimized",
  conversationSummarization: "cost-optimized",
  conversationTitle: "cost-optimized",
  approvalCopy: "cost-optimized",
  approvalConversation: "cost-optimized",
  trustRuleSuggestion: "cost-optimized",
  styleAnalyzer: "cost-optimized",
  inference: "cost-optimized",
  heartbeatAgent: "cost-optimized",
  commitMessage: "cost-optimized",
  replySuggestion: "cost-optimized",
  guardianQuestionCopy: "cost-optimized",
  notificationDecision: "cost-optimized",
  preferenceExtraction: "cost-optimized",
  interactionClassifier: "cost-optimized",
  inviteInstructionGenerator: "cost-optimized",
  skillCategoryInference: "cost-optimized",
  homeGreeting: "cost-optimized",
  homeSuggestedPrompts: "cost-optimized",
  voiceProgressNarration: "latency-optimized",
  voiceFrontDoor: "latency-optimized",
};

// Providers whose model set is not code-known: endpoint-supplied catalogs
// (openai-compatible, litellm) and keyless ollama (arbitrary local pulls).
// Their servability is indeterminate, so their tweaks always keep.
const UNJUDGEABLE_PROVIDERS = new Set([
  "ollama",
  "openai-compatible",
  "litellm",
]);

// Frozen snapshot of the models the Vellum managed route serves: the union
// of the managed-routable providers' catalog models as of 2026-08-20.
const VELLUM_ROUTABLE_MODELS = new Set([
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-5-20251101",
  "claude-haiku-4-5-20251001",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "accounts/fireworks/models/kimi-k3",
  "accounts/fireworks/models/kimi-k2p6",
  "accounts/fireworks/models/glm-5p2",
  "accounts/fireworks/models/minimax-m3",
  "accounts/fireworks/models/minimax-m2p7",
  "accounts/fireworks/models/deepseek-v4-pro",
  "accounts/fireworks/models/deepseek-v4-flash-0731",
  "MiniMaxAI/MiniMax-M3",
]);

// Frozen snapshot of the ChatGPT-subscription (Codex) allowlist.
const CODEX_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
]);

// Frozen per-provider catalog model map for vendor kinds as of 2026-08-20.
// Kinds absent here are judged indeterminate (their tweaks keep).
const CATALOG_MODELS: Record<string, ReadonlySet<string>> = {
  anthropic: new Set([
    "claude-fable-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-5-20251101",
    "claude-haiku-4-5-20251001",
  ]),
  openai: new Set([
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.4",
    "gpt-5.2",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
  ]),
  gemini: new Set([
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-3.1-pro-preview-customtools",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite-preview",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
  ]),
  fireworks: new Set([
    "accounts/fireworks/models/kimi-k3",
    "accounts/fireworks/models/kimi-k2p6",
    "accounts/fireworks/models/glm-5p2",
    "accounts/fireworks/models/minimax-m3",
    "accounts/fireworks/models/minimax-m2p7",
    "accounts/fireworks/models/deepseek-v4-pro",
    "accounts/fireworks/models/deepseek-v4-flash-0731",
  ]),
  together: new Set(["MiniMaxAI/MiniMax-M3"]),
  openrouter: new Set([
    "anthropic/claude-fable-5",
    "anthropic/claude-opus-5",
    "anthropic/claude-opus-4.8",
    "anthropic/claude-opus-4.7",
    "anthropic/claude-opus-4.6",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-opus-4.5",
    "anthropic/claude-haiku-4.5",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-sol-pro",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-terra-pro",
    "openai/gpt-5.6-luna",
    "openai/gpt-5.6-luna-pro",
    "x-ai/grok-4.5",
    "x-ai/grok-4.3",
    "x-ai/grok-4.20",
    "deepseek/deepseek-r1-0528",
    "deepseek/deepseek-chat-v3-0324",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v3.2-speciale",
    "qwen/qwen3.5-plus-02-15",
    "qwen/qwen3.5-397b-a17b",
    "qwen/qwen3.5-flash-02-23",
    "qwen/qwen3-coder-next",
    "moonshotai/kimi-k3",
    "moonshotai/kimi-k2.6",
    "moonshotai/kimi-k2.5",
    "minimax/minimax-m3",
    "minimax/minimax-m2.7",
    "minimax/minimax-m2.5",
    "minimax/minimax-m2.1",
    "minimax/minimax-m2",
    "minimax/minimax-m2-her",
    "minimax/minimax-m1",
    "minimax/minimax-01",
    "z-ai/glm-5.2",
    "mistralai/mistral-medium-3",
    "mistralai/mistral-small-2603",
    "mistralai/devstral-2512",
    "meta-llama/llama-4-maverick",
    "meta-llama/llama-4-scout",
    "amazon/nova-pro-v1",
    "openrouter/owl-alpha",
  ]),
  "vercel-ai-gateway": new Set([
    "anthropic/claude-fable-5",
    "anthropic/claude-opus-5",
    "anthropic/claude-opus-4.8",
    "anthropic/claude-opus-4.6",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-haiku-4.5",
    "openai/gpt-5.5",
    "openai/gpt-5.5-pro",
    "xai/grok-4.3",
    "moonshotai/kimi-k2.6",
    "deepseek/deepseek-v4-flash",
  ]),
  minimax: new Set(["MiniMax-M3", "MiniMax-M2.7"]),
  atlascloud: new Set(["deepseek-ai/deepseek-v4-pro"]),
  baseten: new Set(["thinkingmachines/inkling"]),
  poolside: new Set(["poolside/laguna-s-2.1", "poolside/laguna-xs-2.1"]),
};

export const stripCallSiteProviderOverridesMigration: WorkspaceMigration = {
  id: "147-strip-call-site-provider-overrides",
  description:
    "Strip provider from llm.callSites.* tweaks and drop tweaks whose model the winning route cannot serve",
  retryFailedCheckpoint: true,
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return;
      }
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const llm = asObject(config.llm);
    if (llm === null) {
      return;
    }
    const callSites = asObject(llm.callSites);
    if (callSites === null) {
      return;
    }

    // Connection rows are read lazily (only when a winner is an entry-name
    // label) and at most once per run. `null` = unreadable, judged
    // indeterminate by `isServable`.
    let rowsCache: Map<string, string> | null | undefined;
    const getRows = (): Map<string, string> | null => {
      if (rowsCache === undefined) {
        rowsCache = readConnectionRows(workspaceDir);
      }
      return rowsCache;
    };

    let changed = false;
    for (const [site, value] of Object.entries(callSites)) {
      const entry = asObject(value);
      if (entry === null) {
        continue;
      }

      if ("provider" in entry) {
        log.info(
          { callSite: site, provider: entry.provider },
          "Deleted schema-dead provider from a call-site tweak",
        );
        delete entry.provider;
        changed = true;
      }
      if ("provider_connection" in entry) {
        log.info(
          { callSite: site, binding: entry.provider_connection },
          "Deleted schema-dead provider_connection from a call-site tweak",
        );
        delete entry.provider_connection;
        changed = true;
      }

      const model = entry.model;
      if (typeof model === "string" && model.length > 0) {
        const winner = winnerProviderForSite(site, entry, llm);
        const servable =
          winner === null ? null : isServable(winner, model, getRows);
        if (servable === false) {
          delete callSites[site];
          changed = true;
          log.warn(
            {
              callSite: site,
              provider: winner,
              model,
              reason: "model_not_servable",
            },
            "Deleted call-site tweak; the winning route cannot serve its model",
          );
          continue;
        }
      }

      // A present-but-empty tweak suppresses the shipped call-site default;
      // delete it so the default applies.
      if (Object.keys(entry).length === 0) {
        delete callSites[site];
        changed = true;
        log.info({ callSite: site }, "Deleted empty call-site tweak");
      }
    }

    if (changed) {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    }
  },
  down(_workspaceDir: string): void {
    // Forward-only: the stripped keys were schema-dead and deleted tweaks
    // are not reconstructible.
  },
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The winning route's provider for a call site, or null when it cannot be
 * determined (mix winners, unknown profiles): the resolver's selection
 * chain without the per-turn override rung, which stored config cannot
 * express.
 */
function winnerProviderForSite(
  site: string,
  entry: Record<string, unknown>,
  llm: Record<string, unknown>,
): string | null {
  const rungs: (string | null)[] = [];
  if (site === "mainAgent") {
    rungs.push(asNonEmptyString(llm.activeProfile));
  }
  rungs.push(asNonEmptyString(entry.profile));
  for (const name of rungs) {
    if (name === null) {
      continue;
    }
    const rung = rungProvider(name, llm);
    if (rung === "fall_through") {
      continue;
    }
    return rung;
  }
  return defaultIntentProvider(site, llm);
}

/**
 * A named rung's provider: the profile's own provider when it is plainly
 * usable (judged as the vellum identity when the profile pins the managed
 * "vellum" connection and its model is vellum-routable, mirroring
 * migration 148's fold), the intent column for default-key names with no
 * workspace entry
 * (or an explicitly managed stub, which the resolver overrides with the
 * code-owned body), "fall_through" when the name resolves to nothing, and
 * null when the outcome cannot be determined. A user-owned workspace entry
 * in any state that is not plainly usable is indeterminate on purpose: the
 * effective profile view materializes default bodies through workspace
 * state this migration does not reproduce, and deletion must never ride on
 * an approximation.
 */
function rungProvider(
  name: string,
  llm: Record<string, unknown>,
): string | "fall_through" | null {
  const entry = asObject(asObject(llm.profiles)?.[name]);
  if (entry === null) {
    return DEFAULT_PROFILE_KEYS.has(name)
      ? columnProvider(llm)
      : "fall_through";
  }
  if (entry.mix != null) {
    // A mix winner's arm is a seeded pick this migration does not reproduce.
    return null;
  }
  const model = asNonEmptyString(entry.model);
  const usableProvider =
    entry.status !== "disabled" && model !== null
      ? asNonEmptyString(entry.provider)
      : null;
  if (usableProvider !== null) {
    // A profile still carrying a `provider_connection` pin on the managed
    // "vellum" connection routes managed: migration 148 (which runs next)
    // folds the pin into the vellum identity when the profile's model is
    // vellum-routable. Servability is judged by that post-fold winner, not
    // the declared vendor, so this pass never deletes a tweak the managed
    // route serves.
    if (
      entry.provider_connection === "vellum" &&
      model !== null &&
      VELLUM_ROUTABLE_MODELS.has(model)
    ) {
      return "vellum";
    }
    return usableProvider;
  }
  // A managed stub of a default key is overridden by the code-owned intent
  // column; any other present-but-not-plainly-usable entry is indeterminate.
  if (DEFAULT_PROFILE_KEYS.has(name) && entry.source === "managed") {
    return columnProvider(llm);
  }
  return null;
}

/**
 * The shipped-default rung: the site's intent implemented by a plainly
 * usable user shadow, the code-owned intent column through
 * `llm.defaultProvider` when no user-owned shadow exists, and null
 * (indeterminate) for a user-owned shadow in any other state, mirroring
 * `rungProvider`'s fail-open posture.
 */
function defaultIntentProvider(
  site: string,
  llm: Record<string, unknown>,
): string | null {
  const intent = SHIPPED_CALL_SITE_INTENTS[site] ?? "balanced";
  const rung = rungProvider(intent, llm);
  return rung === "fall_through" ? columnProvider(llm) : rung;
}

/** The default-profile column's provider: `llm.defaultProvider` or vellum. */
function columnProvider(llm: Record<string, unknown>): string {
  return asNonEmptyString(asObject(llm.defaultProvider)?.provider) ?? "vellum";
}

/**
 * Whether a route can serve a model, judged against the frozen snapshots.
 * Null = indeterminate (unknown kinds, entry rows that cannot be read,
 * providers whose model set is not code-known); the caller keeps the model.
 */
function isServable(
  provider: string,
  model: string,
  getRows: () => Map<string, string> | null,
  depth = 0,
): boolean | null {
  if (provider === "vellum") {
    return VELLUM_ROUTABLE_MODELS.has(model);
  }
  if (provider === "chatgpt") {
    return CODEX_MODELS.has(model);
  }
  const catalog = CATALOG_MODELS[provider];
  if (catalog !== undefined) {
    return catalog.has(model);
  }
  if (UNJUDGEABLE_PROVIDERS.has(provider) || depth > 0) {
    return null;
  }
  // Not a vendor or identity: treat the value as a connection entry name
  // and judge by its row's kind.
  const rows = getRows();
  if (rows === null) {
    return null;
  }
  const kind = rows.get(provider);
  if (kind === undefined) {
    return null;
  }
  return isServable(kind, model, getRows, depth + 1);
}

/**
 * Connection name -> provider kind, or null when the DB or table is not
 * readable (judged indeterminate: this migration never deletes on a guess).
 * An absent DB file is a real state (no rows exist) and yields an empty map.
 */
function readConnectionRows(workspaceDir: string): Map<string, string> | null {
  const dbPath = join(workspaceDir, "data", "db", "assistant.db");
  if (!existsSync(dbPath)) {
    return new Map();
  }
  let db: Database;
  try {
    db = new Database(dbPath);
  } catch {
    return null;
  }
  try {
    const rows = db
      .query(`SELECT name, provider FROM provider_connections`)
      .all() as Array<{ name: string; provider: string }>;
    return new Map(rows.map((r) => [r.name, r.provider]));
  } catch {
    return null;
  } finally {
    db.close();
  }
}
