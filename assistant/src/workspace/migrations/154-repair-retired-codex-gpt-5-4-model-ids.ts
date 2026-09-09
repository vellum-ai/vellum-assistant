import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import type { WorkspaceMigration } from "./types.js";

/**
 * Repair `gpt-5.4` and `gpt-5.4-mini` pins that route through the ChatGPT
 * subscription.
 *
 * OpenAI serves neither model under ChatGPT sign-in: the Codex endpoint
 * rejects them with HTTP 400 ("not supported when using Codex with a
 * ChatGPT account"), so both are out of `CODEX_SUBSCRIPTION_MODEL_IDS`.
 * API-key access is unaffected, so the repair is scoped to fragments that
 * provably dispatch to the subscription; an `openai` (or any other vendor)
 * fragment keeps its model.
 *
 * A fragment routes through the subscription when its `provider` is the
 * `chatgpt` routing identity, or when the `provider_connections` row it
 * dispatches to is the subscription (row kind `chatgpt`, or an
 * `oauth_subscription` auth on the pre-DB-migration-366 row shape). The row
 * is named by the legacy `provider_connection` binding when present (dispatch
 * honors it first), otherwise by an entry-name `provider`. The identity form fails
 * `LLMSchema.superRefine` once the allowlist drops the model, and the
 * loader's per-section salvage then resets the whole `llm` section; the
 * entry-bound form bypasses the auto-resolution compat gate and 400s on
 * every request. Both are swept in `llm.default`, `llm.callSites.*`, and
 * `llm.profiles.*`.
 *
 * A providerless call-site pin overlays the profile that wins that site
 * (`llm.activeProfile` for mainAgent, then the site's `profile`, then the
 * site's shipped intent resolved through `llm.defaultProvider`). With the model outside the
 * allowlist a `chatgpt` winner no longer serves it, so the resolver implies
 * provider `openai` and a subscription-only workspace has no connection for
 * it; a winner pinning the subscription row keeps that pin and 400s. Such a
 * pin is repaired only when the winner is provably subscription-routed: a
 * standard profile bound to the subscription, or a mix whose every arm is.
 * A winner on an API-key or managed route still serves the model, and a mix
 * with any other arm is ambiguous and left alone. The chain skips the rungs
 * the resolver skips: a profile whose provider names no connection row, and
 * user-owned shadows of code-owned names, which resolution ignores. An
 * unusable mix arm skips the rung for the seeds that pick it, so such a mix
 * is subscription-routed only when the rest of the chain is too.
 *
 * Replacements: `gpt-5.4` becomes `gpt-5.5` (its successor) and
 * `gpt-5.4-mini` becomes `gpt-5.6-luna` (the subscription's Balanced model;
 * on the subscription every model bills the same).
 */
export const repairRetiredCodexGpt54ModelIdsMigration: WorkspaceMigration = {
  id: "154-repair-retired-codex-gpt-5-4-model-ids",
  description:
    "Repair gpt-5.4 and gpt-5.4-mini pins on ChatGPT-subscription LLM fragments in workspace config",
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    // Read outside the parse catch: a transient filesystem error (EIO,
    // EACCES) must reach the runner so the migration retries, while
    // malformed JSON is a permanent state this migration cannot repair.
    const rawText = readFileSync(configPath, "utf-8");

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(rawText);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return;
      }
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const llm = readObject(config.llm);
    if (llm === null) {
      return;
    }

    // Entry rows load lazily: only a stale fragment bound to an entry name
    // needs them. An unreadable DB then fails the run (retried next boot)
    // rather than checkpointing a pass that skips entry-bound profiles.
    let rows: Map<string, boolean> | null | undefined;
    const entryRows = (): Map<string, boolean> => {
      if (rows === undefined) {
        rows = readConnectionRows(workspaceDir);
      }
      if (rows === null) {
        throw new Error(
          "provider_connections is not readable; retrying the model-ID repair on the next run",
        );
      }
      return rows;
    };
    const lookup: ProviderLookup = {
      isSubscription: (provider) => {
        if (provider === CHATGPT_IDENTITY) {
          return true;
        }
        if (typeof provider !== "string" || provider.length === 0) {
          return false;
        }
        return entryRows().get(provider) === true;
      },
      isResolvable: (provider) =>
        KNOWN_PROVIDERS.has(provider) || entryRows().has(provider),
    };
    const isSubscriptionProvider = lookup.isSubscription;

    const isBound = (fragment: Record<string, unknown>): boolean =>
      fragmentIsSubscriptionBound(fragment, isSubscriptionProvider);

    let changed = false;

    changed = repairFragment(readObject(llm.default), isBound) || changed;

    const callSites = readObject(llm.callSites);
    if (callSites !== null) {
      for (const [site, rawConfig] of Object.entries(callSites)) {
        const isRouted = (fragment: Record<string, unknown>): boolean =>
          isBound(fragment) ||
          (fragment.provider === undefined &&
            winnerIsSubscriptionRouted(site, llm, lookup));
        changed = repairFragment(readObject(rawConfig), isRouted) || changed;
      }
    }

    const profiles = readObject(llm.profiles);
    if (profiles !== null) {
      for (const rawProfile of Object.values(profiles)) {
        changed = repairFragment(readObject(rawProfile), isBound) || changed;
      }
    }

    if (!changed) {
      return;
    }

    // Write-then-rename so an interrupted write cannot leave config.json
    // truncated: a torn in-place write would parse as invalid JSON on the
    // retry, which the catch above treats as "nothing to do", letting the
    // runner checkpoint the migration as completed against a corrupt file.
    const tmpPath = `${configPath}.migration-154.tmp`;
    writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n");
    renameSync(tmpPath, configPath);
  },
  // The exact-match rewrite is idempotent, so a transient failure (full
  // disk, I/O error) is safe to retry on later startups.
  retryFailedCheckpoint: true,
  down(_workspaceDir: string): void {
    // Forward-only: reintroducing the retired model IDs would fail schema
    // validation once the allowlist no longer carries them.
  },
};

// ---------------------------------------------------------------------------
// Helpers: self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

const CHATGPT_IDENTITY = "chatgpt";

/**
 * Row-backed provider predicates. `isSubscription` answers whether a
 * provider value dispatches to the subscription; `isResolvable` mirrors
 * the resolver's `isResolvableProvider` gate (a known vendor or identity,
 * or an existing entry row), which skips a rung whose provider names no
 * row. Both throw on an unreadable DB so the run retries.
 */
interface ProviderLookup {
  isSubscription: (provider: unknown) => boolean;
  isResolvable: (provider: string) => boolean;
}

// Frozen snapshot of `KNOWN_LLM_PROVIDERS`: the vendor and identity values
// that dispatch without a connection row.
const KNOWN_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "fireworks",
  "openrouter",
  "vercel-ai-gateway",
  "openai-compatible",
  "minimax",
  "atlascloud",
  "together",
  "litellm",
  "opencode",
  "baseten",
  "poolside",
  "vellum",
  "chatgpt",
]);

const REPLACEMENTS: ReadonlyMap<string, string> = new Map([
  ["gpt-5.4", "gpt-5.5"],
  ["gpt-5.4-mini", "gpt-5.6-luna"],
]);

function repairFragment(
  fragment: Record<string, unknown> | null,
  isSubscriptionRouted: (fragment: Record<string, unknown>) => boolean,
): boolean {
  if (fragment === null || typeof fragment.model !== "string") {
    return false;
  }
  const replacement = REPLACEMENTS.get(fragment.model);
  if (replacement === undefined) {
    return false;
  }
  if (!isSubscriptionRouted(fragment)) {
    return false;
  }
  fragment.model = replacement;
  return true;
}

/**
 * Whether a fragment's own routing goes through the subscription. The
 * `chatgpt` identity always does (the schema rejects the pair regardless
 * of any binding). Otherwise the legacy `provider_connection` binding is
 * authoritative when present, since dispatch honors it ahead of the
 * declared provider; only an unbound fragment is judged by its `provider`.
 */
function fragmentIsSubscriptionBound(
  fragment: Record<string, unknown>,
  isSubscriptionProvider: (provider: unknown) => boolean,
): boolean {
  if (fragment.provider === CHATGPT_IDENTITY) {
    return true;
  }
  const binding = fragment.provider_connection;
  if (typeof binding === "string" && binding.length > 0) {
    return isSubscriptionProvider(binding);
  }
  return isSubscriptionProvider(fragment.provider);
}

// Frozen snapshot of `DEFAULT_PROFILE_KEYS`: a reference to one of these
// resolves to the default provider's catalog column unless a user-owned
// shadow in `llm.profiles` stands in for it.
const DEFAULT_PROFILE_KEYS = new Set([
  "balanced",
  "quality-optimized",
  "cost-optimized",
  "latency-optimized",
]);

// Frozen snapshot of `CODE_OWNED_PROFILE_NAMES`: resolution ignores a
// workspace shadow of these names and always serves the code-owned body.
const CODE_OWNED_PROFILE_NAMES = new Set([
  "latency-optimized",
  "balanced-backup",
  "quality-optimized-backup",
  "cost-optimized-backup",
  "latency-optimized-backup",
]);

// Frozen `OS_BETA_PROFILE_KEY`: a materialized managed stub of this name
// resolves to its code-owned vellum body; with no stub the name is missing.
const OS_BETA_PROFILE_KEY = "os-beta";

/**
 * Outcome of one rung. `"skipped"` means the resolver passes over it;
 * `"partial"` is a mix whose usable arms all route through the
 * subscription while its unusable arms skip the rung, so the mix is
 * subscription-routed only when the rest of the chain is.
 */
type Route = boolean | "skipped" | "partial";

// Frozen snapshot of `CALL_SITE_DEFAULTS[site].profile`: the intent a site
// resolves through the default provider once every named rung is skipped.
// A site absent here (`vision`, `workflowLeaf`) anchors on balanced.
const CALL_SITE_INTENTS: Record<string, string> = {
  mainAgent: "balanced",
  subagentSpawn: "balanced",
  compactionAgent: "balanced",
  patternScan: "balanced",
  narrativeRefinement: "balanced",
  callAgent: "balanced",
  memoryConsolidation: "balanced",
  identityIntro: "balanced",
  emptyStateGreeting: "balanced",
  memoryRouter: "cost-optimized",
  memoryV3SelectL2: "balanced",
  recall: "balanced",
  conversationStarters: "balanced",
  filingAgent: "cost-optimized",
  memoryExtraction: "cost-optimized",
  memoryRetrieval: "cost-optimized",
  memoryRetrospective: "cost-optimized",
  memoryV2Migration: "cost-optimized",
  memoryV2Sweep: "cost-optimized",
  memoryV2Consolidation: "balanced",
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
  interactionClassifier: "latency-optimized",
  voiceProgressNarration: "latency-optimized",
  voiceFrontDoor: "latency-optimized",
  voiceContinuationLabel: "cost-optimized",
  inviteInstructionGenerator: "cost-optimized",
  skillCategoryInference: "cost-optimized",
  homeGreeting: "cost-optimized",
  homeSuggestedPrompts: "cost-optimized",
};

/**
 * Whether the profile that wins `site` dispatches through the subscription.
 * Mirrors the resolver's single-winner chain: `llm.activeProfile` (mainAgent
 * only), then `llm.callSites[site].profile`, then the site's shipped intent
 * through `llm.defaultProvider`. A named rung the resolver would skip
 * (missing, disabled, incomplete) falls through to the next one.
 */
function winnerIsSubscriptionRouted(
  site: string,
  llm: Record<string, unknown>,
  lookup: ProviderLookup,
): boolean {
  const siteConfig = readObject(readObject(llm.callSites)?.[site]);
  const rungs =
    site === "mainAgent"
      ? [llm.activeProfile, siteConfig?.profile]
      : [siteConfig?.profile];
  return chainRoute(
    rungs,
    0,
    CALL_SITE_INTENTS[site] ?? "balanced",
    llm,
    lookup,
  );
}

/** Route of the chain from rung `start` on, anchored by the shipped intent. */
function chainRoute(
  rungs: unknown[],
  start: number,
  intent: string,
  llm: Record<string, unknown>,
  lookup: ProviderLookup,
): boolean {
  for (let i = start; i < rungs.length; i++) {
    const route = namedProfileRoute(rungs[i], llm, lookup, true);
    if (route === "skipped") {
      continue;
    }
    if (route === "partial") {
      return chainRoute(rungs, i + 1, intent, llm, lookup);
    }
    return route;
  }
  return defaultIntentRoute(intent, llm, lookup);
}

/**
 * Route of a named rung. A default key without a user-owned shadow resolves
 * to the default provider's column, a materialized OS Beta stub to its
 * code-owned vellum body; any other missing name is skipped.
 */
function namedProfileRoute(
  name: unknown,
  llm: Record<string, unknown>,
  lookup: ProviderLookup,
  allowMix: boolean,
): Route {
  if (typeof name !== "string" || name.length === 0) {
    return "skipped";
  }
  if (name === OS_BETA_PROFILE_KEY) {
    const stub = readObject(readObject(llm.profiles)?.[name]);
    if (stub !== null && stub.source === "managed") {
      return stub.status === "disabled" ? "skipped" : false;
    }
  }
  const shadow = userShadow(name, llm);
  if (shadow === null) {
    return DEFAULT_PROFILE_KEYS.has(name)
      ? defaultProviderIsSubscription(llm, lookup.isSubscription)
      : "skipped";
  }
  return usableShadowRoute(shadow, llm, lookup, allowMix) ?? "skipped";
}

/**
 * Route of a shipped intent: a usable user-owned shadow wins, otherwise the
 * pure catalog column of the default provider stands (the anchor is
 * code-owned and always resolves). A partial mix is anchored by that same
 * column for the seeds that pick an unusable arm.
 */
function defaultIntentRoute(
  intent: string,
  llm: Record<string, unknown>,
  lookup: ProviderLookup,
): boolean {
  const shadow = userShadow(intent, llm);
  const route =
    shadow === null ? undefined : usableShadowRoute(shadow, llm, lookup, true);
  return typeof route === "boolean"
    ? route
    : defaultProviderIsSubscription(llm, lookup.isSubscription);
}

/**
 * A user-owned `llm.profiles` entry that resolution honors. A managed stub
 * is not a shadow, and a shadow of a code-owned name is ignored in favor of
 * the code-owned body.
 */
function userShadow(
  name: string,
  llm: Record<string, unknown>,
): Record<string, unknown> | null {
  if (CODE_OWNED_PROFILE_NAMES.has(name)) {
    return null;
  }
  const shadow = readObject(readObject(llm.profiles)?.[name]);
  return shadow === null || shadow.source === "managed" ? null : shadow;
}

/**
 * Route of a user-owned shadow, or undefined when the resolver treats it as
 * unusable (disabled, incomplete, or a provider that names no connection
 * row). A mix (top level only; arms cannot nest) picks an arm by seed: any
 * arm on another route makes the mix ambiguous (false); an unusable arm
 * skips the rung for its seeds, so a mix of subscription and unusable arms
 * is `"partial"`, and one of only unusable arms is unusable itself.
 */
function usableShadowRoute(
  shadow: Record<string, unknown>,
  llm: Record<string, unknown>,
  lookup: ProviderLookup,
  allowMix: boolean,
): Route | undefined {
  if (shadow.status === "disabled") {
    return undefined;
  }
  if (Array.isArray(shadow.mix)) {
    if (!allowMix || shadow.mix.length === 0) {
      return false;
    }
    const arms = shadow.mix.map((arm) =>
      namedProfileRoute(readObject(arm)?.profile, llm, lookup, false),
    );
    if (arms.some((route) => route !== true && route !== "skipped")) {
      return false;
    }
    if (arms.every((route) => route === "skipped")) {
      return undefined;
    }
    return arms.every((route) => route === true) ? true : "partial";
  }
  if (typeof shadow.provider !== "string" || typeof shadow.model !== "string") {
    return undefined;
  }
  if (!lookup.isResolvable(shadow.provider)) {
    return undefined;
  }
  return fragmentIsSubscriptionBound(shadow, lookup.isSubscription);
}

/**
 * Whether `llm.defaultProvider` routes its default column through the
 * subscription: the `chatgpt` identity, or `openai` pinning a subscription
 * row by `connectionName`.
 */
function defaultProviderIsSubscription(
  llm: Record<string, unknown>,
  isSubscriptionProvider: (provider: unknown) => boolean,
): boolean {
  const defaultProvider = readObject(llm.defaultProvider);
  if (defaultProvider === null) {
    return false;
  }
  if (defaultProvider.provider === CHATGPT_IDENTITY) {
    return true;
  }
  return (
    defaultProvider.provider === "openai" &&
    isSubscriptionProvider(defaultProvider.connectionName)
  );
}

/**
 * `provider_connections` row name to whether the row dispatches to the
 * ChatGPT subscription, or null when the DB or table is not readable. The
 * caller fails the run on null: entry-name providers must be judged against
 * real rows, never guessed. An absent DB file is a real state (no rows, so
 * every entry name is dangling).
 */
function readConnectionRows(workspaceDir: string): Map<string, boolean> | null {
  const dbPath = join(workspaceDir, "data", "db", "assistant.db");
  if (!existsSync(dbPath)) {
    return new Map();
  }
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
  try {
    const rows = db
      .query(`SELECT name, provider, auth FROM provider_connections`)
      .all() as Array<{ name: string; provider: string; auth: string }>;
    return new Map(
      rows.map((row) => [
        row.name,
        row.provider === CHATGPT_IDENTITY || isSubscriptionAuth(row.auth),
      ]),
    );
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function isSubscriptionAuth(auth: string): boolean {
  try {
    const parsed: unknown = JSON.parse(auth);
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { type?: unknown }).type === "oauth_subscription"
    );
  } catch {
    return false;
  }
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
