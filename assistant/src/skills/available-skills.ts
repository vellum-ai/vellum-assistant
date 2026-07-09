import { getConfig } from "../config/loader.js";
import type { SkillSource } from "../config/skills.js";
import type { SkillInstallMeta } from "./install-meta.js";

/**
 * Plugin-facing read API over the skill surface: the locally installed
 * catalog with resolved enablement states, and the remote skill catalog —
 * each composed host-side (catalog load + install-state resolution +
 * feature-flag gating + install-meta read), so callers hold no host config
 * and perform no flag checks of their own.
 *
 * The underlying skill and flag modules are loaded via dynamic `import()`
 * inside each function so that importing this module — which every
 * `@vellumai/plugin-api` consumer does transitively — does not eagerly pull
 * the catalog/flag import graph. An eager pull would force those modules'
 * named exports to resolve at instantiation, which breaks the intentional
 * partial module mocks in tests.
 */

/** One skill as seen by a plugin: capability fields plus resolved state. */
export interface ResolvedSkillEntry {
  id: string;
  displayName: string;
  description: string;
  /** Compact routing cues declared in frontmatter / catalog metadata. */
  activationHints?: string[];
  /** Conditions under which the skill should not be loaded. */
  avoidWhen?: string[];
  /** True when the skill is pinned into the memory selector pool every turn. */
  alwaysCandidate?: boolean;
  /** True for locally installed skills; false for remote catalog entries. */
  installed: boolean;
  /** Where the installed skill comes from. Unset for remote catalog entries. */
  source?: SkillSource;
  /**
   * Resolved availability:
   * - `enabled` / `disabled` — installed, per config and source defaults.
   * - `unavailable` — gated off (feature flag disabled, or a bundled skill
   *   excluded by the `allowBundled` allowlist). Present so callers can still
   *   enumerate the full id universe.
   * - `available` — a remote catalog entry that is not locally installed.
   */
  state: "enabled" | "disabled" | "unavailable" | "available";
  /**
   * Install metadata for user-installed skills (`managed` / `workspace` /
   * `extra` sources): `null` when the directory has no install-meta file,
   * unset for sources that never carry one (bundled, plugin, remote).
   */
  installMeta?: SkillInstallMeta | null;
}

/**
 * The locally installed skill catalog with resolved states. Includes every
 * catalog entry — skills dropped by flag gating or the bundled allowlist are
 * reported with `state: "unavailable"` rather than omitted, so the returned
 * ids are the complete installed universe.
 */
export async function listInstalledSkills(): Promise<ResolvedSkillEntry[]> {
  const [{ loadSkillCatalog }, { resolveSkillStates }, { readInstallMeta }] =
    await Promise.all([
      import("../config/skills.js"),
      import("../config/skill-state.js"),
      import("./install-meta.js"),
    ]);
  const catalog = loadSkillCatalog();
  const stateById = new Map(
    resolveSkillStates(catalog, getConfig()).map((r) => [
      r.summary.id,
      r.state,
    ]),
  );
  return catalog.map((summary) => {
    const entry: ResolvedSkillEntry = {
      id: summary.id,
      displayName: summary.displayName,
      description: summary.description,
      activationHints: summary.activationHints,
      avoidWhen: summary.avoidWhen,
      alwaysCandidate: summary.alwaysCandidate,
      installed: true,
      source: summary.source,
      state: stateById.get(summary.id) ?? "unavailable",
    };
    if (
      summary.source === "managed" ||
      summary.source === "workspace" ||
      summary.source === "extra"
    ) {
      entry.installMeta = readInstallMeta(summary.directoryPath);
    }
    return entry;
  });
}

/**
 * The remote skill catalog, fetched via the shared catalog cache. Entries
 * whose declared feature flag is disabled are reported with
 * `state: "unavailable"`; all others are `state: "available"`. Not deduplicated
 * against the installed catalog — callers that merge the two lists filter by
 * installed ids themselves. Returns an empty array when the catalog is empty
 * and throws when it cannot be fetched, so callers keep their own
 * degraded-mode handling.
 */
export async function listCatalogSkills(): Promise<ResolvedSkillEntry[]> {
  const [{ getCatalog }, { isAssistantFeatureFlagEnabled }] = await Promise.all(
    [
      import("./catalog-cache.js"),
      import("../config/assistant-feature-flags.js"),
    ],
  );
  const catalog = await getCatalog();
  const config = getConfig();
  return catalog.map((entry) => {
    const flagKey = entry.metadata?.vellum?.["feature-flag"];
    const gated =
      typeof flagKey === "string" &&
      flagKey.length > 0 &&
      !isAssistantFeatureFlagEnabled(flagKey, config);
    return {
      id: entry.id,
      displayName: entry.metadata?.vellum?.["display-name"] ?? entry.name,
      description: entry.description,
      activationHints: entry.metadata?.vellum?.["activation-hints"],
      avoidWhen: entry.metadata?.vellum?.["avoid-when"],
      installed: false,
      state: gated ? "unavailable" : "available",
    };
  });
}
