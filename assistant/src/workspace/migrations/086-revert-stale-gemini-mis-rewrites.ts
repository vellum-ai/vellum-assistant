import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Revert mis-rewrites by migration 057 where a non-Gemini fragment was
 * incorrectly treated as Gemini.
 *
 * Migration 057's `inferProvider` helper hardcodes `model === "gemini-3-flash"`
 * as Gemini even when no `provider` is set, but `resolveCallSiteConfig` only
 * infers providers via the catalog and `gemini-3-flash` is not a catalog
 * entry. The runtime resolver therefore leaves such fragments inheriting from
 * lower layers, so a workspace like `llm.default = {provider: "ollama"}` with
 * `llm.callSites.recall = {model: "gemini-3-flash"}` (a user-named local
 * model) resolves as Ollama at runtime — but 057 rewrites that recall model
 * to `gemini-3-flash-preview`, flipping the catalog-based provider inference
 * to Gemini and corrupting the user's intent.
 *
 * For each call-site or profile fragment that currently looks like a 057
 * rewrite output (model in the replacement set, no explicit `provider`), this
 * migration recomputes the effective provider via proper catalog-based
 * inference using only the other layers. If that effective provider is
 * explicitly non-Gemini, the fragment's model is reverted to
 * `gemini-3-flash`, restoring the user's pre-057 state.
 */
export const revertStaleGeminiMisRewritesMigration: WorkspaceMigration = {
  id: "086-revert-stale-gemini-mis-rewrites",
  description:
    "Revert 057 mis-rewrites of gemini-3-flash in non-Gemini fragment contexts",
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

    const defaultBlock = readObject(llm.default);
    const defaultProvider = inferLayerProvider(defaultBlock);
    const profiles = readObject(llm.profiles);
    const activeProfileName =
      typeof llm.activeProfile === "string" ? llm.activeProfile : undefined;

    let changed = false;

    // Pass 1: revert profile candidates first so that pass 2's call-site
    // evaluation sees the reverted profile state. A call-site that references
    // a profile candidate would otherwise infer `siteProfileProvider = gemini`
    // from the profile's pre-revert rewritten model, masking the call-site's
    // own need to revert.
    if (profiles !== null) {
      for (const rawProfile of Object.values(profiles)) {
        const profile = readObject(rawProfile);
        if (profile === null) continue;
        if (!isRevertCandidate(profile)) continue;
        if (isExplicitlyNonGemini(defaultProvider)) {
          profile.model = STALE_MODEL;
          changed = true;
        }
      }
    }

    // Compute the active-profile provider after pass 1 so it reflects any
    // reversion of the active profile itself.
    const activeProfileBlock =
      profiles !== null && activeProfileName !== undefined
        ? readObject(profiles[activeProfileName])
        : null;
    const activeProfileProvider = inferLayerProvider(activeProfileBlock);

    // Pass 2: call-site candidates. `inferLayerProvider` is re-read from
    // `profiles` per call site, so it observes pass 1's reversions.
    const callSites = readObject(llm.callSites);
    if (callSites !== null) {
      for (const [site, rawConfig] of Object.entries(callSites)) {
        const callSiteConfig = readObject(rawConfig);
        if (callSiteConfig === null) continue;
        if (!isRevertCandidate(callSiteConfig)) continue;
        const siteProfileName =
          typeof callSiteConfig.profile === "string"
            ? callSiteConfig.profile
            : undefined;
        const siteProfileBlock =
          profiles !== null && siteProfileName !== undefined
            ? readObject(profiles[siteProfileName])
            : null;
        const siteProfileProvider = inferLayerProvider(siteProfileBlock);

        const effective = effectiveProviderExcludingSite({
          callSite: site,
          siteProfileProvider,
          activeProfileProvider,
          defaultProvider,
        });
        if (isExplicitlyNonGemini(effective)) {
          callSiteConfig.model = STALE_MODEL;
          changed = true;
        }
      }
    }

    if (!changed) return;

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: re-applying the broken rewrite would reintroduce the bug.
  },
};

// ---------------------------------------------------------------------------
// Helpers — self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

const STALE_MODEL = "gemini-3-flash";

// Models 057 writes when rewriting. Any fragment now holding one of these
// values without an explicit provider is a potential mis-rewrite candidate.
const REPLACEMENT_MODELS = new Set<string>([
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
]);

// Subset of the Gemini provider catalog used for per-layer catalog inference.
// Mirrors `getCatalogProviderForModel` for Gemini entries only — for other
// providers we treat a bare model as "provider unknown" and fall through to
// lower layers, which is safe because the revert only fires when at least one
// layer below carries an explicit non-Gemini provider.
const GEMINI_CATALOG_MODELS = new Set<string>([
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
]);

function isRevertCandidate(block: Record<string, unknown>): boolean {
  if (typeof block.provider === "string") return false;
  return typeof block.model === "string" && REPLACEMENT_MODELS.has(block.model);
}

function inferLayerProvider(
  block: Record<string, unknown> | null,
): string | undefined {
  if (block === null) return undefined;
  if (typeof block.provider === "string") return block.provider;
  if (
    typeof block.model === "string" &&
    GEMINI_CATALOG_MODELS.has(block.model)
  ) {
    return "gemini";
  }
  return undefined;
}

function isExplicitlyNonGemini(provider: string | undefined): boolean {
  return provider !== undefined && provider !== "gemini";
}

// Mirrors `resolveCallSiteConfig`'s layered provider resolution, omitting the
// candidate call-site fragment itself (its provider is undefined and its
// model is the replacement value, so including it would always say "gemini"
// via catalog inference — defeating the revert check).
function effectiveProviderExcludingSite(args: {
  callSite: string;
  siteProfileProvider: string | undefined;
  activeProfileProvider: string | undefined;
  defaultProvider: string | undefined;
}): string | undefined {
  const {
    callSite,
    siteProfileProvider,
    activeProfileProvider,
    defaultProvider,
  } = args;
  if (callSite === "mainAgent") {
    return activeProfileProvider ?? siteProfileProvider ?? defaultProvider;
  }
  return siteProfileProvider ?? activeProfileProvider ?? defaultProvider;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
