import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Repair stale Gemini model IDs that earlier workspace migrations could seed.
 *
 * `gemini-3-flash` is no longer a catalog model ID. Repair only known LLM
 * config leaves where migrations write model IDs, only when the value is an
 * exact stale match, and only when the effective provider context is Gemini —
 * a custom Ollama/OpenRouter config that happens to use the literal
 * `"gemini-3-flash"` string must be left untouched.
 */
export const repairStaleGeminiModelIdsMigration: WorkspaceMigration = {
  id: "057-repair-stale-gemini-model-ids",
  description: "Repair stale gemini-3-flash model IDs in workspace LLM config",
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

    const defaultBlock = readObject(llm.default);
    const defaultProvider = readProvider(defaultBlock);
    const profiles = readObject(llm.profiles);
    const activeProfileName =
      typeof llm.activeProfile === "string" ? llm.activeProfile : undefined;
    const activeProfileProvider =
      profiles !== null && activeProfileName !== undefined
        ? inferProvider(readObject(profiles[activeProfileName]))
        : undefined;

    if (defaultBlock !== null && isGeminiProvider(defaultProvider)) {
      changed = repairModel(defaultBlock, DEFAULT_REPLACEMENT_MODEL) || changed;
    }

    const callSites = readObject(llm.callSites);
    if (callSites !== null) {
      for (const [site, rawConfig] of Object.entries(callSites)) {
        const callSiteConfig = readObject(rawConfig);
        if (callSiteConfig === null) continue;
        const effective = resolveCallSiteEffectiveProvider({
          callSite: site,
          callSiteConfig,
          profiles,
          activeProfileProvider,
          defaultProvider,
        });
        if (!isGeminiProvider(effective)) continue;
        const replacement = LATENCY_CALL_SITES.has(site)
          ? LATENCY_REPLACEMENT_MODEL
          : DEFAULT_REPLACEMENT_MODEL;
        changed = repairModel(callSiteConfig, replacement) || changed;
      }
    }

    if (profiles !== null) {
      for (const rawProfile of Object.values(profiles)) {
        const profile = readObject(rawProfile);
        if (profile === null) continue;
        const effective = inferProvider(profile) ?? defaultProvider;
        if (!isGeminiProvider(effective)) continue;
        changed = repairModel(profile, DEFAULT_REPLACEMENT_MODEL) || changed;
      }
    }

    if (!changed) return;

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: reintroducing the stale model ID would break Gemini calls.
  },
};

// ---------------------------------------------------------------------------
// Helpers — self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

const STALE_MODEL = "gemini-3-flash";
const DEFAULT_REPLACEMENT_MODEL = "gemini-3-flash-preview";
const LATENCY_REPLACEMENT_MODEL = "gemini-3.1-flash-lite-preview";

const LATENCY_CALL_SITES = new Set([
  "analyzeConversation",
  "conversationSummarization",
  "memoryRetrieval",
]);

function repairModel(
  config: Record<string, unknown>,
  replacement: string,
): boolean {
  if (config.model !== STALE_MODEL) return false;
  config.model = replacement;
  return true;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readProvider(
  block: Record<string, unknown> | null,
): string | undefined {
  if (block === null) return undefined;
  return typeof block.provider === "string" ? block.provider : undefined;
}

// Mirrors `resolveCallSiteConfig`'s catalog-based inference: a fragment with
// no explicit `provider` but a Gemini-catalog `model` resolves to "gemini" at
// that layer. The stale model is the only catalog entry the migration cares
// about, so the check stays self-contained.
function inferProvider(
  block: Record<string, unknown> | null,
): string | undefined {
  if (block === null) return undefined;
  const explicit = readProvider(block);
  if (explicit !== undefined) return explicit;
  if (block.model === STALE_MODEL) return "gemini";
  return undefined;
}

function isGeminiProvider(provider: string | undefined): boolean {
  return provider === undefined || provider === "gemini";
}

// Walks the call-site provider resolution chain the same way
// `resolveCallSiteConfig` does: for `mainAgent`, `activeProfile` overrides the
// static `callSites.mainAgent` block, while for every other call site the
// call-site block (and its referenced profile) wins over `activeProfile`.
// Returns the highest-precedence inferred provider, falling back to `default`.
function resolveCallSiteEffectiveProvider(args: {
  callSite: string;
  callSiteConfig: Record<string, unknown>;
  profiles: Record<string, unknown> | null;
  activeProfileProvider: string | undefined;
  defaultProvider: string | undefined;
}): string | undefined {
  const {
    callSite,
    callSiteConfig,
    profiles,
    activeProfileProvider,
    defaultProvider,
  } = args;
  const siteProvider = inferProvider(callSiteConfig);
  const siteProfileName =
    typeof callSiteConfig.profile === "string"
      ? callSiteConfig.profile
      : undefined;
  const siteProfileProvider =
    profiles !== null && siteProfileName !== undefined
      ? inferProvider(readObject(profiles[siteProfileName]))
      : undefined;

  if (callSite === "mainAgent") {
    return (
      activeProfileProvider ??
      siteProvider ??
      siteProfileProvider ??
      defaultProvider
    );
  }
  return (
    siteProvider ??
    siteProfileProvider ??
    activeProfileProvider ??
    defaultProvider
  );
}
