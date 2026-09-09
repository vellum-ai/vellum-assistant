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
 * A providerless call-site pin overlays whichever profile wins that site
 * for a turn. With the model outside the allowlist a subscription-routed
 * winner no longer serves it, so the resolver implies provider `openai`
 * and a subscription-only workspace has no connection for it; a winner
 * pinning the subscription row keeps that pin and 400s. The winner is not
 * fixed by config alone: a per-conversation pin, a schedule's pin, and the
 * advisor profile each take the top rung for the turns they cover, and any
 * selectable profile can be pinned after this one-time run. So the pin is
 * repaired when any selectable profile in the workspace routes through the
 * subscription (a default key resolving to the `chatgpt` column, or a
 * usable user-owned profile bound to the subscription), the way resolution
 * would honor it: shadows of code-owned names and managed stubs are
 * ignored, and disabled, incomplete, or row-unresolvable profiles cannot
 * win. A workspace with no such profile serves the model on every route
 * it can select, and a call site this snapshot does not know (written by a
 * newer assistant) is left alone.
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
        if (
          typeof provider !== "string" ||
          provider.length === 0 ||
          KNOWN_PROVIDERS.has(provider)
        ) {
          return false;
        }
        return entryRows().get(provider) === true;
      },
      isResolvable: (provider) =>
        KNOWN_PROVIDERS.has(provider) || entryRows().has(provider),
    };

    const isBound = (fragment: Record<string, unknown>): boolean =>
      fragmentIsSubscriptionBound(fragment, lookup.isSubscription);

    // Memoized: the answer is per workspace, and computing it may read rows.
    let selectable: boolean | undefined;
    const anySelectableSubscriptionProfile = (): boolean => {
      if (selectable === undefined) {
        selectable = hasSelectableSubscriptionProfile(llm, lookup);
      }
      return selectable;
    };

    let changed = false;

    changed = repairFragment(readObject(llm.default), isBound) || changed;

    const callSites = readObject(llm.callSites);
    if (callSites !== null) {
      for (const [site, rawConfig] of Object.entries(callSites)) {
        const isRouted = (fragment: Record<string, unknown>): boolean =>
          isBound(fragment) ||
          (fragment.provider === undefined &&
            KNOWN_CALL_SITES.has(site) &&
            anySelectableSubscriptionProfile());
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
 * or an existing entry row), which keeps a profile whose provider names no
 * row from winning. Both throw on an unreadable DB so the run retries.
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

// Frozen snapshot of `DEFAULT_PROFILE_KEYS`: each resolves to the default
// provider's catalog column unless a usable user-owned shadow in
// `llm.profiles` stands in for it.
const DEFAULT_PROFILE_KEYS = new Set([
  "balanced",
  "quality-optimized",
  "cost-optimized",
  "latency-optimized",
]);

// Frozen snapshot of `CODE_OWNED_PROFILE_NAMES`: resolution ignores a
// workspace shadow of these names and serves the code-owned body, which
// never routes through the subscription on its own (`latency-optimized`
// is judged through the default provider like the other default keys).
// Every other managed stub (a default key, a backup, `os-beta`) is likewise
// its code-owned body: the default provider's column for a default key, a
// vellum body otherwise.
const CODE_OWNED_PROFILE_NAMES = new Set([
  "latency-optimized",
  "balanced-backup",
  "quality-optimized-backup",
  "cost-optimized-backup",
  "latency-optimized-backup",
]);

// Frozen snapshot of `LLMCallSiteEnum`: the sites whose resolution this
// migration knows. A site outside it was written by a newer assistant.
const KNOWN_CALL_SITES = new Set([
  "mainAgent",
  "subagentSpawn",
  "heartbeatAgent",
  "filingAgent",
  "compactionAgent",
  "callAgent",
  "memoryExtraction",
  "memoryConsolidation",
  "memoryRetrieval",
  "memoryV2Migration",
  "memoryV2Sweep",
  "memoryRouter",
  "memoryV3SelectL2",
  "memoryV2Consolidation",
  "memoryRetrospective",
  "recall",
  "narrativeRefinement",
  "patternScan",
  "conversationSummarization",
  "conversationStarters",
  "replySuggestion",
  "conversationTitle",
  "commitMessage",
  "identityIntro",
  "emptyStateGreeting",
  "notificationDecision",
  "preferenceExtraction",
  "guardianQuestionCopy",
  "approvalCopy",
  "approvalConversation",
  "interactionClassifier",
  "styleAnalyzer",
  "inviteInstructionGenerator",
  "skillCategoryInference",
  "inference",
  "vision",
  "voiceProgressNarration",
  "voiceFrontDoor",
  "voiceContinuationLabel",
  "trustRuleSuggestion",
  "homeGreeting",
  "homeSuggestedPrompts",
  "workflowLeaf",
]);

/**
 * Whether any profile a turn can select routes through the subscription:
 * a default key whose effective body is the `chatgpt` column, or a usable
 * user-owned profile bound to the subscription. Mix profiles add nothing
 * of their own: their arms are selectable profiles in their own right.
 */
function hasSelectableSubscriptionProfile(
  llm: Record<string, unknown>,
  lookup: ProviderLookup,
): boolean {
  const profiles = readObject(llm.profiles);
  const names = new Set([
    ...DEFAULT_PROFILE_KEYS,
    ...(profiles === null ? [] : Object.keys(profiles)),
  ]);
  for (const name of names) {
    if (profileIsSubscriptionRouted(name, llm, lookup)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the effective body of `name` routes through the subscription.
 * Code-owned names and managed stubs resolve to code-owned bodies: a
 * default key to the default provider's column, everything else to a
 * vellum body. A user-owned shadow wins only when usable (enabled,
 * complete, provider resolvable); an unusable shadow of a default key
 * reverts to the column, and any other unusable profile cannot win.
 */
function profileIsSubscriptionRouted(
  name: string,
  llm: Record<string, unknown>,
  lookup: ProviderLookup,
): boolean {
  const shadow = userShadow(name, llm);
  const usable =
    shadow !== null &&
    shadow.status !== "disabled" &&
    !Array.isArray(shadow.mix) &&
    typeof shadow.provider === "string" &&
    typeof shadow.model === "string" &&
    lookup.isResolvable(shadow.provider);
  if (usable) {
    return fragmentIsSubscriptionBound(shadow, lookup.isSubscription);
  }
  return (
    DEFAULT_PROFILE_KEYS.has(name) &&
    defaultProviderIsSubscription(llm, lookup.isSubscription)
  );
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
