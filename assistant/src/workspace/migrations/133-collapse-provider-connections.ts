import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("migrations/133-collapse-provider-connections");

// Collapse the user-facing provider-connection references in LLM config onto
// provider values:
//
// - `provider_connection: "vellum"` entries become `provider: "vellum"` (the
//   routing identity) and lose the connection field — dispatch derives the
//   managed upstream from the model.
// - `provider_connection: "chatgpt-subscription"` entries become
//   `provider: "chatgpt"` when their model is a Codex subscription model.
// - The conventional `<provider>-personal` reference is dropped: the
//   provider field plus dispatch's auto-resolution picks the same row. Any
//   other reference (renamed rows, one of several rows for a provider,
//   openai-compatible endpoints) is an explicit selection with no lossless
//   replacement and stays.
// - `llm.defaultProvider.connectionName` is dropped when conventional —
//   convention resolution recovers exactly it from the provider value.
// - The legacy raw `llm.default` blob is deleted.
//
// A rewritten identity entry must hold a model the identity can route (the
// config schema strips identity entries with unroutable models on read — a
// stripped profile is a silently deleted profile). Routability is decided
// against the frozen snapshots below; an entry that fails the check keeps
// its concrete provider and only loses the dangling connection reference,
// which dispatch reports as an explainable resolution error.
//
// Model ids and provider names are hardcoded: this is a frozen historical
// snapshot of the catalog at migration time.

const MANAGED_PREFIX_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "gemini",
  "fireworks",
  "together",
]);

const MANAGED_MODEL_IDS = new Set([
  // anthropic
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-5-20251101",
  "claude-haiku-4-5-20251001",
  // openai
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  // gemini
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
  // fireworks
  "accounts/fireworks/models/kimi-k2p6",
  "accounts/fireworks/models/glm-5p2",
  "accounts/fireworks/models/kimi-k2p5",
  "accounts/fireworks/models/minimax-m3",
  "accounts/fireworks/models/minimax-m2p7",
  "accounts/fireworks/models/minimax-m2p5",
  "accounts/fireworks/models/deepseek-v4-pro",
  "accounts/fireworks/models/deepseek-v4-flash",
  // together
  "MiniMaxAI/MiniMax-M3",
]);

const CODEX_MODEL_IDS = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
]);

const VELLUM_CONNECTION = "vellum";
const CHATGPT_CONNECTION = "chatgpt-subscription";
const ROUTING_IDENTITIES = new Set(["vellum", "chatgpt"]);

export const collapseProviderConnectionsMigration: WorkspaceMigration = {
  id: "133-collapse-provider-connections",
  description:
    "Rewrite managed/subscription provider_connection references onto provider values; drop conventional connection names and the legacy llm.default blob",
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

    const llm = readObject(config.llm);
    if (llm === null) return;

    let changed = false;

    // The legacy raw blob predates profile-based resolution; materialization
    // falls back to schema defaults without it.
    if (llm.default !== undefined) {
      delete llm.default;
      changed = true;
      log.info("Deleted legacy llm.default blob");
    }

    // Only conventional names are dropped — convention resolution recovers
    // exactly them from the provider value. A non-conventional pin is an
    // explicit selection with no lossless replacement, so it stays.
    const defaultProvider = readObject(llm.defaultProvider);
    if (
      defaultProvider !== null &&
      defaultProvider.connectionName !== undefined
    ) {
      const name = defaultProvider.connectionName;
      const provider = defaultProvider.provider;
      const conventional =
        name === VELLUM_CONNECTION ||
        (typeof provider === "string" && name === `${provider}-personal`);
      if (conventional) {
        delete defaultProvider.connectionName;
        changed = true;
      } else {
        log.info(
          { connectionName: name, provider },
          "Kept a non-conventional defaultProvider.connectionName pin",
        );
      }
    }

    for (const section of ["profiles", "callSites"] as const) {
      const entries = readObject(llm[section]);
      if (entries === null) continue;
      for (const key of Object.keys(entries)) {
        const entry = readObject(entries[key]);
        if (entry === null) continue;
        if (rewriteEntry(entry, `llm.${section}.${key}`)) changed = true;
      }
    }

    if (changed) {
      config.llm = llm;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    }
  },
  down(_workspaceDir: string): void {
    // Forward-only.
  },
};

/**
 * Rewrite a single profile / call-site entry in place. Returns true when the
 * entry changed.
 */
function rewriteEntry(entry: Record<string, unknown>, label: string): boolean {
  const provider = typeof entry.provider === "string" ? entry.provider : null;
  const connection =
    typeof entry.provider_connection === "string"
      ? entry.provider_connection
      : null;

  // Identity entries carry their target in the provider value; a lingering
  // connection stamp is dead weight. Encoded models on them decode to the
  // native id the schema requires.
  if (provider !== null && ROUTING_IDENTITIES.has(provider)) {
    let changed = false;
    if (entry.provider_connection !== undefined) {
      delete entry.provider_connection;
      changed = true;
      log.info(
        { label },
        "Stripped stale provider_connection from a routing-identity entry",
      );
    }
    const decoded = decodeRoutedModel(entry.model);
    if (decoded !== null) {
      entry.model = decoded;
      changed = true;
      log.info(
        { label, model: decoded },
        "Decoded routed model string to its native id",
      );
    }
    return changed;
  }

  if (connection === null) return false;

  if (connection === VELLUM_CONNECTION) {
    const decoded = decodeRoutedModel(entry.model);
    const model =
      decoded ?? (typeof entry.model === "string" ? entry.model : null);
    if (model !== null && MANAGED_MODEL_IDS.has(model)) {
      entry.provider = "vellum";
      entry.model = model;
      delete entry.provider_connection;
      log.info(
        { label, model },
        'Rewrote vellum-connection entry to provider "vellum"',
      );
    } else {
      // Not provably routable (unknown/stale/absent model): rewriting would
      // produce an entry the config schema strips on read. Keep the stamped
      // provider; dispatch reports the missing connection explainably.
      delete entry.provider_connection;
      log.warn(
        { label, model: entry.model, provider },
        "Dropped vellum connection without identity rewrite — model is not a known managed-routable id",
      );
    }
    return true;
  }

  if (connection === CHATGPT_CONNECTION) {
    const model = typeof entry.model === "string" ? entry.model : null;
    if (model !== null && CODEX_MODEL_IDS.has(model)) {
      entry.provider = "chatgpt";
      delete entry.provider_connection;
      log.info(
        { label, model },
        'Rewrote chatgpt-subscription entry to provider "chatgpt"',
      );
    } else {
      delete entry.provider_connection;
      log.warn(
        { label, model: entry.model, provider },
        "Dropped chatgpt-subscription connection without identity rewrite — model is not a Codex subscription id",
      );
    }
    return true;
  }

  // Only the conventional seeded name has a lossless replacement: the
  // provider field plus dispatch's auto-resolution picks the same row. Any
  // other reference (renamed rows, one of several rows for a provider,
  // openai-compatible endpoints) is an explicit selection the scan cannot
  // reproduce deterministically, so it stays.
  if (connection === `${provider}-personal`) {
    delete entry.provider_connection;
    log.info(
      { label, connection },
      "Dropped conventional provider_connection reference",
    );
    return true;
  }
  return false;
}

/**
 * Decode an encoded `<managed-provider>/<model>` routing string to its native
 * model id, or null when the value is not an encoded id for a known managed
 * model. Fireworks/together native ids contain slashes but their prefixes
 * ("accounts", "MiniMaxAI") are not managed provider names, so they pass
 * through untouched.
 */
function decodeRoutedModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const slash = value.indexOf("/");
  if (slash <= 0) return null;
  const prefix = value.slice(0, slash);
  const rest = value.slice(slash + 1);
  if (!MANAGED_PREFIX_PROVIDERS.has(prefix) || rest.length === 0) return null;
  return MANAGED_MODEL_IDS.has(rest) ? rest : null;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
