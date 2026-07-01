/**
 * Route handlers for the assistant plugins surface.
 *
 * GET    /v1/plugins          — list installed plugins under `<workspaceDir>/plugins/`.
 * GET    /v1/plugins/search   — search the canonical GitHub catalog of installable plugins.
 * GET    /v1/plugins/:name    — resolve a single plugin's detail view (metadata + README).
 * POST   /v1/plugins/install  — install a plugin by name from the canonical source.
 * DELETE /v1/plugins/:name    — uninstall a plugin from `<workspaceDir>/plugins/<name>/`.
 *
 * The read-only routes are projections over the same library functions
 * the CLI uses (`assistant plugins list`, `assistant plugins search`).
 * The install / uninstall routes are symmetric to `assistant plugins
 * install` / `uninstall` and delegate to the same `installPlugin` /
 * `uninstallPlugin` lib functions. CLI / daemon / web stay aligned on
 * what an installed or available plugin looks like — mirroring the
 * skills surface, which already exposes detail + install over HTTP.
 *
 * # Policy gating
 *
 * Reads require `settings.read`; install and uninstall require
 * `settings.write`. The HTTP router enforces the per-route `policy`
 * block below, and the IPC route adapter ships the same policy in
 * `get_route_schema` so the gateway's IPC proxy stays in sync.
 */

import { z } from "zod";

import {
  diffPlugin,
  PluginDiffUnavailableError,
} from "../../cli/lib/diff-plugin.js";
import {
  inspectPlugin,
  PluginInspectNotFoundError,
} from "../../cli/lib/inspect-plugin.js";
import {
  DEFAULT_PLUGIN_REF,
  installPlugin,
  InvalidPluginNameError,
  PluginAlreadyInstalledError,
  PluginNotFoundError,
  PluginSourceUnavailableError,
} from "../../cli/lib/install-from-github.js";
import {
  type InstalledPluginInfo,
  listInstalledPlugins,
} from "../../cli/lib/list-installed-plugins.js";
import { getPluginCatalog } from "../../cli/lib/plugin-catalog-cache.js";
import {
  getPluginDetails,
  PluginDetailsNotFoundError,
} from "../../cli/lib/plugin-details.js";
import {
  DEFAULT_PIN_HISTORY_LIMIT,
  listPinHistory,
  PluginPinHistoryError,
  resolvePinToMarketplaceCommit,
} from "../../cli/lib/plugin-pin-history.js";
import {
  assertValidSearchPattern,
  filterPluginCatalog,
  InvalidSearchPatternError,
  PluginCatalogUnavailableError,
  type PluginSearchMatch,
} from "../../cli/lib/search-plugins.js";
import {
  disablePlugin,
  enablePlugin,
  InvalidPluginNameError as InvalidTogglePluginNameError,
  PluginAlreadyInStateException,
  PluginDirectoryNotFoundError,
} from "../../cli/lib/toggle-plugin.js";
import {
  PluginNotInstalledError,
  uninstallPlugin,
} from "../../cli/lib/uninstall-plugin.js";
import {
  PluginMergeBaselineError,
  PluginNotUpgradableError,
  type PluginUpgradeStrategy,
  upgradePlugin,
} from "../../cli/lib/upgrade-plugin.js";
import { isPluginDisabled } from "../../plugins/disabled-state.js";
import { getLocalCategorySlugs } from "../../skills/categories-cache.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  getOriginClientId,
  publishPluginsChanged,
} from "../sync/resource-sync-events.js";
import {
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
  RouteError,
  ServiceUnavailableError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const pluginInfoSchema = z.object({
  id: z
    .string()
    .describe(
      "Plugin's directory name (kebab-case). Matches `assistant plugins install <id>`.",
    ),
  name: z.string().describe("Display name. Equal to `id` today."),
  enabled: z
    .boolean()
    .describe(
      "Whether the plugin is active in this workspace. `false` when a `.disabled` sentinel is present under its directory; `true` otherwise.",
    ),
  description: z
    .string()
    .nullable()
    .describe("From `package.json#description`; `null` when unknown."),
  version: z
    .string()
    .nullable()
    .describe("From `package.json#version`; `null` when unknown."),
  path: z
    .string()
    .optional()
    .describe("Absolute path to the plugin directory on the assistant host."),
  issues: z
    .array(z.string())
    .optional()
    .describe(
      "Non-fatal issues with this entry (missing `package.json`, malformed JSON, ...). Omitted when clean.",
    ),
  category: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Marketplace category slug (Skills taxonomy); null when origin/category is unknown, e.g. non-marketplace installs.",
    ),
});

const pluginsListResponseSchema = z.object({
  plugins: z.array(pluginInfoSchema),
  categoryCounts: z
    .record(z.string(), z.number())
    .optional()
    .describe(
      "Installed plugins per category (before the category filter is applied).",
    ),
  totalCount: z
    .number()
    .optional()
    .describe("Total installed plugins matching non-category filters."),
});

const pluginMatchSourceSchema = z
  .object({
    kind: z.literal("github"),
    repo: z
      .string()
      .describe("`owner/repo` of the external plugin repository."),
    path: z
      .string()
      .optional()
      .describe(
        "Directory within the repo, when the plugin is not at the root.",
      ),
    ref: z.string().describe("Pinned git ref the plugin is fetched from."),
  })
  .describe("Origin of the match: a whitelisted external plugin repository.");

const pluginSearchMatchSchema = z.object({
  name: z
    .string()
    .describe("Install name. Matches `assistant plugins install <name>`."),
  path: z
    .string()
    .describe(
      "Human-readable origin: a `github:owner/repo@ref` locator for the external plugin.",
    ),
  description: z
    .string()
    .optional()
    .describe("Short description, when known (external entries only today)."),
  category: z
    .string()
    .nullable()
    .describe(
      "Marketplace category slug (Skills taxonomy); null when the entry declares none.",
    ),
  source: pluginMatchSourceSchema,
});

const pluginsSearchResponseSchema = z.object({
  query: z
    .string()
    .describe("Echo of the requested query (ECMAScript regex source)."),
  ref: z.string().describe("Git ref the catalog was listed at."),
  matches: z
    .array(pluginSearchMatchSchema)
    .describe("Directory matches, sorted alphabetically by name."),
});

const pluginUninstallResponseSchema = z.object({
  name: z
    .string()
    .describe(
      "Directory name that was removed. Echoes the request's `:name` path parameter after sanitization.",
    ),
  target: z
    .string()
    .describe(
      "Absolute path that was removed on the assistant host. Useful for audit logs and confirmation toasts.",
    ),
});

const pluginDetailsResponseSchema = z.object({
  name: z
    .string()
    .describe("Install name. Matches `assistant plugins install <name>`."),
  installed: z
    .boolean()
    .describe(
      "Whether a copy is materialized under `<workspaceDir>/plugins/<name>/`.",
    ),
  description: z
    .string()
    .nullable()
    .describe(
      "Short description, best-effort across disk, manifest, and repo.",
    ),
  homepage: z.string().nullable().describe("Project homepage URL, when known."),
  license: z
    .string()
    .nullable()
    .describe("SPDX license expression, when known."),
  version: z
    .string()
    .nullable()
    .describe(
      "Resolved version (installed copy first, then repo `package.json`).",
    ),
  source: pluginMatchSourceSchema
    .nullable()
    .describe(
      "Pinned origin from the marketplace entry, or null when an installed copy has no catalog entry.",
    ),
  readme: z
    .string()
    .nullable()
    .describe("README markdown, or null when the plugin ships none."),
  ref: z
    .string()
    .describe("Git ref the catalog metadata / README were resolved at."),
  artifact: z
    .object({
      url: z
        .string()
        .describe("HTTPS URL the prebuilt client artifact is downloaded from."),
      sha256: z
        .string()
        .describe(
          "Lowercase 64-char hex SHA-256 the download is verified against.",
        ),
      label: z
        .string()
        .optional()
        .describe(
          'Optional human label for the download (e.g. "Download for macOS"); absent when the plugin doesn\'t name it.',
        ),
    })
    .nullable()
    .describe(
      "Prebuilt client artifact from `package.json` `vellum.artifact`, or null when the plugin ships none or its descriptor is incomplete (e.g. a placeholder sha256).",
    ),
});

const pluginInstallRequestSchema = z.object({
  name: z
    .string()
    .describe("Install name to resolve against the marketplace catalog."),
  force: z
    .boolean()
    .optional()
    .describe("Overwrite an existing install in place. Defaults to false."),
  pin: z
    .string()
    .optional()
    .describe(
      "Install a specific reviewed marketplace pin (full commit SHA) instead of the current one. The pin is validated against the plugin's marketplace pin history (`GET /v1/plugins/:name/versions`) and installed from the marketplace revision that introduced it; an unreviewed SHA is rejected. Use this to roll a plugin back to an older reviewed version.",
    ),
});

const pluginInstallResponseSchema = z.object({
  ok: z.literal(true),
  name: z.string().describe("Install name that was materialized."),
  target: z
    .string()
    .describe("Absolute path the plugin was materialized into on the host."),
  fileCount: z
    .number()
    .describe("Number of files written for the installed plugin."),
  ref: z.string().describe("Git ref the plugin was fetched from."),
});

const pluginPinHistoryEntrySchema = z.object({
  pin: z
    .string()
    .describe("Plugin commit SHA pinned at this point in marketplace history."),
  marketplaceCommit: z
    .string()
    .describe(
      "Marketplace-manifest commit to install this pin from (the newest commit carrying it).",
    ),
  promotedAt: z
    .string()
    .nullable()
    .describe(
      "ISO-8601 committer date (UTC) of the marketplace commit that promoted this pin; null when unreadable.",
    ),
  current: z
    .boolean()
    .describe("True for the pin currently active on the default branch."),
});

const pluginVersionsResponseSchema = z
  .array(pluginPinHistoryEntrySchema)
  .describe(
    "Distinct marketplace pins a plugin has been promoted to, newest first; the first entry is the current pin. Empty when the plugin has no resolvable history.",
  );

const fingerprintComparisonSchema = z
  .object({
    modified: z
      .array(z.string())
      .describe("Tracked files whose content changed since install."),
    added: z
      .array(z.string())
      .describe("Files present on disk but absent from the install baseline."),
    removed: z
      .array(z.string())
      .describe("Files recorded at install but missing from the on-disk copy."),
    clean: z
      .boolean()
      .describe("True when no files were added, removed, or modified."),
  })
  .describe(
    "Local-edit comparison of the on-disk tree against the install-time fingerprint.",
  );

const installMetaSourceSchema = z
  .object({
    kind: z.string().describe("Source kind. Only `github` is written today."),
    owner: z.string(),
    repo: z.string(),
    path: z
      .string()
      .optional()
      .describe(
        "Repo-relative directory holding the plugin root; absent = repo root.",
      ),
    ref: z
      .string()
      .describe(
        "Ref the install resolved through (the pinned commit SHA for marketplace installs).",
      ),
  })
  .describe(
    "Source coordinates recorded in the install-time provenance sidecar.",
  );

const pluginLocalInfoSchema = z
  .object({
    target: z
      .string()
      .describe("Absolute path to the installed plugin directory."),
    commit: z
      .string()
      .nullable()
      .describe(
        "Resolved commit the copy was installed at; null when no provenance was recorded.",
      ),
    committedAt: z
      .string()
      .nullable()
      .describe(
        "ISO-8601 committer timestamp (UTC) of the installed commit — the human-readable version; null for installs predating commit-timestamp capture. Distinct from `installedAt`.",
      ),
    version: z
      .string()
      .nullable()
      .describe("Installed `package.json#version`."),
    description: z
      .string()
      .nullable()
      .describe("Installed `package.json#description`."),
    installedAt: z
      .string()
      .nullable()
      .describe(
        "ISO-8601 install timestamp from the sidecar; null when absent.",
      ),
    source: installMetaSourceSchema
      .nullable()
      .describe(
        "Source recorded at install time; null when no sidecar exists.",
      ),
    localChanges: fingerprintComparisonSchema
      .nullable()
      .describe(
        "Local-edit state vs the install-time fingerprint; null when no baseline was recorded (older/manual install).",
      ),
    issues: z
      .array(z.string())
      .describe(
        "Non-fatal issues with the installed copy (e.g. malformed `package.json`).",
      ),
  })
  .describe("The locally installed copy of the plugin.");

const pluginRemoteInfoSchema = z
  .object({
    repo: z
      .string()
      .describe("`owner/repo` of the external plugin repository."),
    path: z
      .string()
      .describe(
        'Repo-relative directory holding the plugin root; `""` = repo root.',
      ),
    commit: z
      .string()
      .describe(
        "Pinned commit SHA the marketplace currently resolves installs to.",
      ),
    committedAt: z
      .string()
      .nullable()
      .describe(
        "ISO-8601 committer timestamp (UTC) of the pinned commit, resolved from GitHub; null when the commit metadata could not be fetched.",
      ),
    description: z.string().nullable(),
    homepage: z.string().nullable(),
    license: z.string().nullable(),
    category: z.string().nullable(),
    marketplaceRef: z
      .string()
      .describe(
        "Ref of the canonical repo the marketplace manifest was read from.",
      ),
  })
  .describe("The marketplace's current pin and advertised metadata.");

const pluginSurfacesSchema = z
  .object({
    skills: z
      .array(z.string())
      .describe("Skill ids shipped at `skills/<id>/SKILL.md`."),
    hooks: z
      .array(z.string())
      .describe(
        "Lifecycle hook names from `hooks/<name>.{ts,js}` (e.g. `pre-model-call`).",
      ),
    tools: z
      .array(z.string())
      .describe(
        "Registered tool names from `tools/<name>.{ts,js}` (filenames derived to tool names, e.g. `create-issue` \u2192 `create_issue`).",
      ),
  })
  .describe(
    "Surfaces the installed copy contributes, read from its on-disk tree.",
  );

const pluginInspectResponseSchema = z.object({
  name: z
    .string()
    .describe("Install name. Matches `assistant plugins install <name>`."),
  installed: z
    .boolean()
    .describe(
      "Whether a copy is materialized under `<workspaceDir>/plugins/`.",
    ),
  status: z
    .enum([
      "up-to-date",
      "update-available",
      "not-installed",
      "not-in-marketplace",
      "unknown-provenance",
      "remote-unavailable",
    ])
    .describe(
      "Drift classification between the installed copy and the marketplace pin.",
    ),
  local: pluginLocalInfoSchema
    .nullable()
    .describe("Locally installed copy; null when the plugin is not installed."),
  remote: pluginRemoteInfoSchema
    .nullable()
    .describe(
      "Marketplace pin + metadata; null when no entry claims the name or it was unreachable.",
    ),
  remoteError: z
    .string()
    .nullable()
    .describe(
      "Marketplace fetch error message, when the catalog could not be read.",
    ),
  surfaces: pluginSurfacesSchema
    .nullable()
    .describe(
      "Surfaces the installed copy contributes (skills, hooks, tools); null when the plugin is not installed.",
    ),
});

const pluginUpgradeRequestSchema = z.object({
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Report what would change without modifying the install. Defaults to false.",
    ),
  strategy: z
    .enum(["ours", "theirs", "overwrite", "assistant"])
    .optional()
    .describe(
      "How to reconcile local edits with the pin. `overwrite` (default) discards local edits and re-installs the pin; `ours`/`theirs` three-way merge, resolving conflicting hunks toward the local edit or the pin respectively; `assistant` is not yet supported.",
    ),
});

const pluginUpgradeResponseSchema = z.object({
  name: z.string().describe("Install name that was (or would be) upgraded."),
  outcome: z
    .enum(["upgraded", "already-up-to-date", "would-upgrade"])
    .describe(
      "`upgraded` moved the install to the pin; `already-up-to-date` was a no-op; `would-upgrade` is a dry-run that found drift.",
    ),
  fromCommit: z
    .string()
    .nullable()
    .describe(
      "Installed commit before the upgrade; null when no provenance was recorded.",
    ),
  fromTimestamp: z
    .string()
    .nullable()
    .describe(
      "ISO-8601 committer timestamp (UTC) of `fromCommit` — the version moved from; null when not recorded.",
    ),
  toCommit: z
    .string()
    .describe(
      "Marketplace-pinned commit the install was (or would be) moved to.",
    ),
  toTimestamp: z
    .string()
    .nullable()
    .describe(
      "ISO-8601 committer timestamp (UTC) of `toCommit` — the version moved to; null when it could not be resolved.",
    ),
  target: z
    .string()
    .describe("Absolute path to the installed plugin directory on the host."),
  fileCount: z
    .number()
    .nullable()
    .describe(
      "Files materialized by the upgrade; null for a no-op or dry run.",
    ),
  dryRun: z.boolean().describe("Whether this was a dry run (no changes made)."),
  strategy: z
    .enum(["ours", "theirs", "overwrite", "assistant"])
    .describe("Conflict-resolution strategy the upgrade applied."),
  conflicts: z
    .array(z.string())
    .describe(
      "Paths left for the assistant to resolve under the `assistant` strategy: text files carry git conflict markers, modify/delete divergences keep the surviving content. Empty for other strategies.",
    ),
  binaryConflicts: z
    .array(z.string())
    .describe(
      "Binary files that conflicted under the `assistant` strategy; the local copy was kept since markers cannot be written into binary content. Empty for other strategies.",
    ),
  provenanceWasUnknown: z
    .boolean()
    .describe(
      "Whether the install lacked resolvable provenance before the upgrade; such installs are re-pinned to record it going forward.",
    ),
});

const pluginFileDiffSchema = z
  .object({
    path: z.string().describe("POSIX-relative path within the plugin root."),
    status: z
      .enum(["modified", "added", "removed"])
      .describe(
        "Whether the file was edited, newly added, or deleted since install.",
      ),
    diff: z
      .string()
      .describe(
        "Unified diff (`--- a/… / +++ b/…`) of the file. A short `Binary files differ` marker for binary files, or a `Baseline unavailable` marker when `reconstructed` is false.",
      ),
    binary: z
      .boolean()
      .describe(
        "True when either side was detected as binary (NUL byte present).",
      ),
    reconstructed: z
      .boolean()
      .describe(
        "True when the install-time baseline for this file was faithfully recovered (re-materialized bytes hash-match the install fingerprint). False when it could not be reconstructed (e.g. the curated adapter overlay changed since install), in which case `diff` is a marker, not a patch. Always true for added files.",
      ),
  })
  .describe("Unified diff of a single drifted file.");

const pluginDiffResponseSchema = z.object({
  name: z
    .string()
    .describe("Install name. Matches `assistant plugins install <name>`."),
  target: z
    .string()
    .describe("Absolute path to the installed plugin directory on the host."),
  commit: z
    .string()
    .describe(
      "Commit the baseline was re-materialized from (the recorded install SHA).",
    ),
  committedAt: z
    .string()
    .nullable()
    .describe(
      "ISO-8601 committer timestamp (UTC) of `commit`; null when not recorded.",
    ),
  clean: z
    .boolean()
    .describe(
      "True when the on-disk tree exactly matches the re-materialized baseline.",
    ),
  files: z
    .array(pluginFileDiffSchema)
    .describe(
      "One entry per drifted file, sorted by path. Empty when `clean`.",
    ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PluginView {
  id: string;
  name: string;
  enabled: boolean;
  description: string | null;
  version: string | null;
  path: string;
  issues?: string[];
  category?: string | null;
}

function projectPlugin(entry: InstalledPluginInfo): PluginView {
  // `id` and `name` both track the directory name. `package.json#name` can
  // be scoped (e.g. `@vendor/plugin-name`) which is fine for npm but not
  // what the CLI uses to install — so we don't surface it as `name`.
  const view: PluginView = {
    id: entry.name,
    name: entry.name,
    // `entry.name` is the plugin directory name, which is the sentinel key.
    enabled: !isPluginDisabled(entry.name),
    description: entry.packageJson?.description ?? null,
    version: entry.packageJson?.version ?? null,
    path: entry.target,
  };
  if (entry.issues.length > 0) {
    view.issues = [...entry.issues];
  }
  return view;
}

/**
 * Marketplace → Skills category slug aliases for known, unambiguous mismatches.
 * Keep this tiny: only add a mapping when it is obviously correct. Marketplace
 * slugs with no clean Skills equivalent are intentionally absent so they fall
 * through to `null` → the "system" bucket.
 */
const MARKETPLACE_CATEGORY_ALIASES: Record<string, string> = {
  developer: "development",
};

/**
 * Normalize a raw marketplace category slug to the shared Skills taxonomy so
 * the rail never carries an invisible bucket. Lowercases + trims, applies the
 * alias map, then returns the slug only when it is a valid Skills slug —
 * otherwise `null`, which buckets under "system" so the plugin stays both
 * counted and reachable. `validSlugs` is resolved once per request by the
 * caller (never per item).
 */
export function normalizeMarketplaceCategory(
  raw: string | null | undefined,
  validSlugs: Set<string>,
): string | null {
  if (!raw) return null;
  const slug = raw.trim().toLowerCase();
  if (!slug) return null;
  const aliased = MARKETPLACE_CATEGORY_ALIASES[slug] ?? slug;
  return validSlugs.has(aliased) ? aliased : null;
}

/**
 * Valid Skills category slugs the marketplace categories normalize against.
 * Sync + local (bundled YAML via the Skills categories-cache) so the plugins
 * list never takes on remote latency; a read failure degrades to an empty set,
 * normalizing every category to `null` → "system" rather than throwing —
 * mirroring the bounded posture of the catalog lookup.
 */
function getValidCategorySlugs(): Set<string> {
  try {
    return getLocalCategorySlugs();
  } catch {
    return new Set();
  }
}

/** Wire shape for a catalog match. Mirrors {@link pluginSearchMatchSchema}. */
interface PluginMatchView {
  name: string;
  path: string;
  description?: string;
  category: string | null;
  source: { kind: "github"; repo: string; path?: string; ref: string };
}

/**
 * Re-pack a `readonly` lib match into a mutable wire object so the route
 * serializer's `Record<string, unknown>` contract holds. The wire shape is
 * identical to {@link PluginSearchMatch}.
 */
function projectMatch(
  m: PluginSearchMatch,
  validSlugs: Set<string>,
): PluginMatchView {
  const view: PluginMatchView = {
    name: m.name,
    path: m.path,
    category: normalizeMarketplaceCategory(m.category, validSlugs),
    source: {
      kind: "github",
      repo: m.source.repo,
      ref: m.source.ref,
      ...(m.source.path !== undefined ? { path: m.source.path } : {}),
    },
  };
  if (m.description !== undefined) {
    view.description = m.description;
  }
  return view;
}

function matchesQuery(plugin: PluginView, needle: string): boolean {
  const q = needle.toLowerCase();
  if (plugin.id.toLowerCase().includes(q)) return true;
  if (plugin.name.toLowerCase().includes(q)) return true;
  if (plugin.description && plugin.description.toLowerCase().includes(q)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Handler — list installed
// ---------------------------------------------------------------------------

/** Uncategorized fallback bucket — matches the Skills taxonomy default. */
const UNCATEGORIZED = "system";

/**
 * Time budget for the marketplace category lookup on the installed list.
 * The installed list is a fast local read; the catalog is a remote GitHub
 * fetch that can hang on a cold cache. Bounding the lookup keeps `GET
 * /v1/plugins` responsive during a marketplace slowdown.
 */
const CATEGORY_LOOKUP_TIMEOUT_MS = 1500;

/**
 * Resolve the marketplace category map, racing the catalog fetch against a
 * timer so a slow/hanging GitHub fetch can't block the installed list: on a
 * rejection or a timeout past {@link CATEGORY_LOOKUP_TIMEOUT_MS} it degrades to
 * an empty map (every `category` resolves to `null`). `timeoutMs` is injectable
 * so tests can exercise the bound without the full production budget.
 */
export async function loadCategoryMapBounded(
  timeoutMs: number = CATEGORY_LOOKUP_TIMEOUT_MS,
): Promise<Map<string, string | null>> {
  // Clear the timer once the race settles so a catalog-wins path doesn't leave
  // the timer pending per request (matters for shutdown / test handles).
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const catalog = await Promise.race([
      getPluginCatalog(DEFAULT_PLUGIN_REF, {
        fetch: globalThis.fetch.bind(globalThis),
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (!catalog) return new Map();
    return new Map(catalog.matches.map((m) => [m.name, m.category]));
  } catch {
    return new Map();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function handleListPlugins({
  queryParams = {},
}: RouteHandlerArgs): Promise<{
  plugins: PluginView[];
  categoryCounts: Record<string, number>;
  totalCount: number;
}> {
  const q = queryParams.q?.trim();
  const category = queryParams.category?.trim();

  const installed = listInstalledPlugins();
  const projected = installed.map(projectPlugin);

  // Nothing installed → `categoryCounts`/`totalCount` are deterministically
  // empty and there is nothing to categorize, so skip the network-bound catalog
  // lookup entirely (no wasted GitHub request or bounded stall wait).
  if (projected.length === 0) {
    return { plugins: [], categoryCounts: {}, totalCount: 0 };
  }

  // Categories live only in the catalog. A marketplace outage OR slowdown must
  // never block the installed list, so the lookup is bounded: it degrades to an
  // empty map (every category becomes `null`) on a rejection or a stall.
  const categoryMap = await loadCategoryMapBounded();

  // Normalize raw marketplace slugs to the shared Skills taxonomy once per
  // request: a raw slug with no Skills row (e.g. `developer`, `memory`) would
  // otherwise be counted in "All" yet unreachable by any rail row. Normalizing
  // maps the unambiguous ones (`developer` → `development`) and folds the rest
  // to `null` → "system", so counts always match visible rows.
  const validSlugs = getValidCategorySlugs();

  // An installed plugin's `id` is its directory name, which is the catalog
  // match's `name` — so it's the lookup key.
  const withCategory = projected.map((p) => ({
    ...p,
    category: normalizeMarketplaceCategory(categoryMap.get(p.id), validSlugs),
  }));

  let list = q ? withCategory.filter((p) => matchesQuery(p, q)) : withCategory;

  // Counts are taken BEFORE the category filter so the rail badges stay stable
  // while a single category is selected.
  const categoryCounts: Record<string, number> = {};
  for (const p of list) {
    const bucket = p.category ?? UNCATEGORIZED;
    categoryCounts[bucket] = (categoryCounts[bucket] ?? 0) + 1;
  }
  const totalCount = list.length;

  if (category) {
    list = list.filter((p) => (p.category ?? UNCATEGORIZED) === category);
  }

  return { plugins: list, categoryCounts, totalCount };
}

// ---------------------------------------------------------------------------
// Handler — search catalog
// ---------------------------------------------------------------------------

interface PluginsSearchResponse {
  query: string;
  ref: string;
  matches: PluginMatchView[];
}

async function handleSearchPlugins({
  queryParams = {},
}: RouteHandlerArgs): Promise<PluginsSearchResponse> {
  // Empty string is a legitimate "match everything" query per the lib's
  // contract — accept it without forcing the caller to pick a sentinel.
  const query = queryParams.q ?? "";
  const ref = queryParams.ref?.trim() || DEFAULT_PLUGIN_REF;

  try {
    // Reject a malformed regex before any network I/O so a user typo is a
    // cheap deterministic 400 — never a wasted GitHub request that could
    // surface as 503 on a cold cache when upstream is rate-limited.
    assertValidSearchPattern(query);
    // The catalog is cached per ref (and served stale on upstream failure),
    // so repeated searches don't re-hit GitHub's unauthenticated rate limit.
    // Filtering by the query is an in-memory operation over that catalog.
    const catalog = await getPluginCatalog(ref, {
      fetch: globalThis.fetch.bind(globalThis),
    });
    const matches = filterPluginCatalog(catalog, query);
    // Resolve the valid Skills slugs once per request, then normalize each
    // match's marketplace category against them so "Available" filters
    // consistently against the same taxonomy as the installed rail.
    const validSlugs = getValidCategorySlugs();
    // Re-pack `readonly` lib types into mutable copies so the route
    // serializer's `Record<string, unknown>` contract holds. The wire
    // shape is identical.
    return {
      query,
      ref: catalog.ref,
      matches: matches.map((m) => projectMatch(m, validSlugs)),
    };
  } catch (err) {
    if (err instanceof InvalidSearchPatternError) {
      throw new BadRequestError(err.message);
    }
    // A rate-limited or unavailable upstream (with no cache to fall back on)
    // is transient and retryable — surface it as 503 rather than a
    // misleading 500 so the client can show a "temporarily unavailable"
    // state and retry later.
    if (err instanceof PluginCatalogUnavailableError) {
      throw new ServiceUnavailableError(err.message);
    }
    throw new InternalError(
      err instanceof Error ? err.message : "plugin catalog search failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Handler — uninstall
// ---------------------------------------------------------------------------

interface PluginUninstallResponse {
  name: string;
  target: string;
}

function handleUninstallPlugin({
  pathParams = {},
}: RouteHandlerArgs): PluginUninstallResponse {
  // The HTTP router has already URL-decoded `:name` for us; pass it
  // through verbatim — `uninstallPlugin` runs the same
  // `sanitizePluginName` check the CLI uses, so attacker-supplied
  // `../escape` style names get rejected before `rmSync` is reached.
  const rawName = pathParams.name ?? "";

  try {
    const result = uninstallPlugin({ name: rawName });
    return { name: result.name, target: result.target };
  } catch (err) {
    if (err instanceof InvalidPluginNameError) {
      throw new BadRequestError(err.message);
    }
    if (err instanceof PluginNotInstalledError) {
      throw new NotFoundError(err.message);
    }
    throw new InternalError(
      err instanceof Error ? err.message : "plugin uninstall failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Handler — detail view
// ---------------------------------------------------------------------------

async function handleGetPluginDetails({
  pathParams = {},
  queryParams = {},
}: RouteHandlerArgs) {
  const rawName = pathParams.name ?? "";
  const ref = queryParams.ref?.trim() || undefined;

  try {
    return await getPluginDetails(
      { name: rawName, ref },
      { fetch: globalThis.fetch.bind(globalThis) },
    );
  } catch (err) {
    if (err instanceof InvalidPluginNameError) {
      throw new BadRequestError(err.message);
    }
    if (err instanceof PluginDetailsNotFoundError) {
      throw new NotFoundError(err.message);
    }
    throw new InternalError(
      err instanceof Error ? err.message : "plugin detail lookup failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Handler — install
// ---------------------------------------------------------------------------

/**
 * Resolve the marketplace ref an install should read from. With no `pin`, that
 * is the default reviewed branch. With a `pin`, it is the marketplace commit
 * that introduced that pin — but only when the pin appears in the plugin's
 * reviewed history; an unreviewed SHA is rejected as a bad request so the route
 * never installs an unvetted revision.
 */
async function resolveInstallMarketplaceRef(
  name: string,
  pin: string | undefined,
): Promise<string> {
  if (!pin) return DEFAULT_PLUGIN_REF;
  const entry = await resolvePinToMarketplaceCommit(name, pin, {
    fetch: globalThis.fetch.bind(globalThis),
  });
  if (!entry) {
    throw new BadRequestError(
      `"${pin}" is not a reviewed marketplace pin for "${name}". ` +
        `Use GET /v1/plugins/${name}/versions to list installable pins.`,
    );
  }
  return entry.marketplaceCommit;
}

async function handleInstallPlugin({ body = {} }: RouteHandlerArgs) {
  const name = typeof body.name === "string" ? body.name : "";
  if (!name) {
    throw new BadRequestError("`name` is required");
  }
  const force = typeof body.force === "boolean" ? body.force : undefined;
  const pin = typeof body.pin === "string" ? body.pin : undefined;

  // The marketplace ref is never taken raw from the request: a caller-supplied
  // ref would let any `settings.write` principal install from an unreviewed
  // revision (a PR branch, fork ref, ...) whose manifest could carry attacker
  // code the loader then dynamically imports. Installs over HTTP therefore
  // resolve only against reviewed history. A `pin` is honored by mapping it —
  // server-side — to the marketplace commit that introduced it, but only if it
  // appears in the plugin's reviewed pin history; an unreviewed SHA is refused.
  // The default install reads the current catalog on `DEFAULT_PLUGIN_REF`.
  // Operators who need an unreviewed revision use the local CLI's
  // `assistant plugins install --pin <sha> --allow-unreviewed`.
  try {
    const marketplaceRef = await resolveInstallMarketplaceRef(name, pin);
    const result = await installPlugin(
      { name, ref: marketplaceRef, force },
      { fetch: globalThis.fetch.bind(globalThis) },
    );
    return {
      ok: true as const,
      name: result.name,
      target: result.target,
      fileCount: result.fileCount,
      ref: result.ref,
    };
  } catch (err) {
    // Pin resolution already maps unreviewed/bad-pin cases to a RouteError;
    // re-throw those verbatim rather than masking them as a 500.
    if (err instanceof RouteError) {
      throw err;
    }
    if (err instanceof InvalidPluginNameError) {
      throw new BadRequestError(err.message);
    }
    if (err instanceof PluginAlreadyInstalledError) {
      throw new ConflictError(err.message);
    }
    if (err instanceof PluginNotFoundError) {
      throw new NotFoundError(err.message);
    }
    // A rate-limited or otherwise temporarily-down GitHub source is
    // retryable, so surface 503 rather than a misleading 500.
    if (err instanceof PluginSourceUnavailableError) {
      throw new ServiceUnavailableError(err.message);
    }
    // The pin-history read hits GitHub too; treat its failures as retryable.
    if (err instanceof PluginPinHistoryError) {
      throw new ServiceUnavailableError(err.message);
    }
    throw new InternalError(
      err instanceof Error ? err.message : "plugin install failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Handler — inspect (drift)
// ---------------------------------------------------------------------------

async function handleInspectPlugin({ pathParams = {} }: RouteHandlerArgs) {
  const rawName = pathParams.name ?? "";

  try {
    // `inspectPlugin` never throws for an unreachable marketplace when a local
    // copy exists — it reports `status: "remote-unavailable"` and captures the
    // message in `remoteError`. It only throws when there is nothing to show.
    return await inspectPlugin(
      { name: rawName },
      { fetch: globalThis.fetch.bind(globalThis) },
    );
  } catch (err) {
    if (err instanceof InvalidPluginNameError) {
      throw new BadRequestError(err.message);
    }
    if (err instanceof PluginInspectNotFoundError) {
      throw new NotFoundError(err.message);
    }
    throw new InternalError(
      err instanceof Error ? err.message : "plugin inspect failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Handler — versions (marketplace pin history)
// ---------------------------------------------------------------------------

async function handlePluginVersions({
  pathParams = {},
  queryParams = {},
}: RouteHandlerArgs) {
  const rawName = pathParams.name ?? "";

  let limit: number | undefined;
  if (queryParams.limit !== undefined) {
    const parsed = Number.parseInt(queryParams.limit, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestError("`limit` must be a positive integer.");
    }
    limit = parsed;
  }

  try {
    return await listPinHistory(
      rawName,
      { fetch: globalThis.fetch.bind(globalThis) },
      limit !== undefined ? { limit } : {},
    );
  } catch (err) {
    if (err instanceof InvalidPluginNameError) {
      throw new BadRequestError(err.message);
    }
    // The history read hits GitHub; its failures are retryable upstream errors.
    if (err instanceof PluginPinHistoryError) {
      throw new ServiceUnavailableError(err.message);
    }
    throw new InternalError(
      err instanceof Error ? err.message : "plugin versions failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Handler — diff
// ---------------------------------------------------------------------------

async function handleDiffPlugin({ pathParams = {} }: RouteHandlerArgs) {
  const rawName = pathParams.name ?? "";

  try {
    return await diffPlugin(
      { name: rawName },
      { fetch: globalThis.fetch.bind(globalThis) },
    );
  } catch (err) {
    if (err instanceof InvalidPluginNameError) {
      throw new BadRequestError(err.message);
    }
    if (
      err instanceof PluginNotInstalledError ||
      err instanceof PluginNotFoundError
    ) {
      throw new NotFoundError(err.message);
    }
    // The install exists but recorded no commit to re-materialize a baseline
    // from — a permanent state the caller cannot resolve by retrying. 409
    // marks the request as well-formed but not actionable in the current state.
    if (err instanceof PluginDiffUnavailableError) {
      throw new ConflictError(err.message);
    }
    // A rate-limited or temporarily-down source (the plugin repo) is a
    // retryable outage, not a conflict — 503.
    if (err instanceof PluginSourceUnavailableError) {
      throw new ServiceUnavailableError(err.message);
    }
    throw new InternalError(
      err instanceof Error ? err.message : "plugin diff failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Handler — upgrade
// ---------------------------------------------------------------------------

async function handleUpgradePlugin({
  pathParams = {},
  body = {},
}: RouteHandlerArgs) {
  const rawName = pathParams.name ?? "";
  const dryRun = typeof body.dryRun === "boolean" ? body.dryRun : undefined;
  const strategy =
    typeof body.strategy === "string"
      ? (body.strategy as PluginUpgradeStrategy)
      : undefined;

  // Like install, the upgrade target ref is the curated marketplace pin
  // (resolved inside `upgradePlugin` via `inspectPlugin`), never a
  // caller-supplied ref — a `settings.write` principal cannot redirect the
  // upgrade at an unreviewed revision.
  try {
    const result = await upgradePlugin(
      { name: rawName, dryRun, strategy },
      { fetch: globalThis.fetch.bind(globalThis) },
    );
    return {
      name: result.name,
      outcome: result.outcome,
      fromCommit: result.fromCommit,
      fromTimestamp: result.fromTimestamp,
      toCommit: result.toCommit,
      toTimestamp: result.toTimestamp,
      target: result.target,
      fileCount: result.fileCount,
      dryRun: result.dryRun,
      strategy: result.strategy,
      conflicts: result.conflicts,
      binaryConflicts: result.binaryConflicts,
      provenanceWasUnknown: result.provenanceWasUnknown,
    };
  } catch (err) {
    if (err instanceof InvalidPluginNameError) {
      throw new BadRequestError(err.message);
    }
    if (err instanceof PluginNotInstalledError) {
      throw new NotFoundError(err.message);
    }
    if (err instanceof PluginNotFoundError) {
      throw new NotFoundError(err.message);
    }
    // A merge strategy was requested but the install-time baseline can't be
    // reconstructed — a well-formed request that isn't actionable in the
    // current state (the caller can retry with `overwrite` or reinstall).
    if (err instanceof PluginMergeBaselineError) {
      throw new ConflictError(err.message);
    }
    // The install exists but has no marketplace entry to advance to — a
    // permanent state the caller cannot resolve by retrying. 409 marks the
    // request as well-formed but not actionable in the current state.
    if (err instanceof PluginNotUpgradableError) {
      throw new ConflictError(err.message);
    }
    // A rate-limited or temporarily-down source (the plugin repo or the
    // marketplace catalog) is a retryable outage, not a conflict — 503.
    if (err instanceof PluginSourceUnavailableError) {
      throw new ServiceUnavailableError(err.message);
    }
    throw new InternalError(
      err instanceof Error ? err.message : "plugin upgrade failed",
    );
  }
}

// ---------------------------------------------------------------------------
// Handler — enable / disable
// ---------------------------------------------------------------------------

/**
 * Map a `toggle-plugin` lib error onto the transport-agnostic route error.
 * `enablePlugin` / `disablePlugin` throw their own taxonomy (distinct from the
 * install/uninstall libs): a malformed name → 400, no plugin directory → 404,
 * and a no-op toggle (already in the requested state) → 409. Anything else
 * (e.g. a filesystem failure) surfaces as an unexpected 500.
 */
function mapTogglePluginError(err: unknown): RouteError {
  if (err instanceof InvalidTogglePluginNameError) {
    return new BadRequestError(err.message);
  }
  if (err instanceof PluginDirectoryNotFoundError) {
    return new NotFoundError(err.message);
  }
  if (err instanceof PluginAlreadyInStateException) {
    return new ConflictError(err.message);
  }
  return new InternalError(
    err instanceof Error ? err.message : "plugin toggle failed",
  );
}

/**
 * Toggle a plugin's `.disabled` sentinel through the shared toggle-plugin lib,
 * then publish a generic `sync_changed(plugins:list)` via the canonical
 * resource-sync publisher so every client refetches `GET /v1/plugins`. Enable
 * and disable emit the SAME invalidation — the tag names WHICH resource is
 * stale, not the new value. The origin client id is threaded through so the
 * initiating client can self-echo-suppress; `publishPluginsChanged` swallows
 * broadcast failures, so a hub error never fails a toggle that already
 * succeeded.
 */
function handleEnablePlugin({ pathParams = {}, headers }: RouteHandlerArgs) {
  try {
    enablePlugin(pathParams.name ?? "");
    publishPluginsChanged(getOriginClientId(headers));
    return { ok: true };
  } catch (err) {
    throw mapTogglePluginError(err);
  }
}

function handleDisablePlugin({ pathParams = {}, headers }: RouteHandlerArgs) {
  try {
    disablePlugin(pathParams.name ?? "");
    publishPluginsChanged(getOriginClientId(headers));
    return { ok: true };
  } catch (err) {
    throw mapTogglePluginError(err);
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "plugins_list",
    endpoint: "plugins",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List installed plugins",
    description:
      "Return one entry per directory under `<workspaceDir>/plugins/`, sorted alphabetically. Matches the CLI's `assistant plugins list`. Supports `?q=<text>` for case-insensitive substring matching across plugin id, name, and description. Each entry carries a `category` (marketplace slug from the Skills taxonomy, or `null` for non-marketplace installs); the response also reports `categoryCounts` (per-category totals, computed before the category filter) and `totalCount`. `?category=<slug>` filters the returned plugins by category server-side while leaving the counts unfiltered. A marketplace outage degrades `category` to `null` without failing the list.",
    tags: ["plugins"],
    queryParams: [
      {
        name: "q",
        schema: { type: "string" },
        description:
          "Optional substring filter applied to plugin id, name, and description.",
      },
      {
        name: "category",
        schema: { type: "string" },
        description:
          "Filter installed plugins by category slug (Skills taxonomy).",
      },
    ],
    responseBody: pluginsListResponseSchema,
    handler: handleListPlugins,
  },
  {
    operationId: "plugins_search",
    endpoint: "plugins/search",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Search the plugin catalog",
    description:
      "List installable plugins from the curated `plugins/marketplace.json` catalog. The query is an ECMAScript regex matched case-insensitively against the plugin name (e.g. `memory`, `^simple`). Empty query returns every entry. Mirrors the CLI's `assistant plugins search`.",
    tags: ["plugins"],
    queryParams: [
      {
        name: "q",
        schema: { type: "string" },
        description:
          "ECMAScript regex pattern matched case-insensitively against catalog directory names. Empty/missing matches everything.",
      },
      {
        name: "ref",
        schema: { type: "string" },
        description:
          "Optional git ref to list the catalog at. Defaults to the CLI's `DEFAULT_PLUGIN_REF` (typically `main`).",
      },
    ],
    responseBody: pluginsSearchResponseSchema,
    handler: handleSearchPlugins,
  },
  {
    operationId: "plugins_install",
    endpoint: "plugins/install",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Install a plugin",
    description:
      "Install a plugin by name from the canonical source — a whitelisted `plugins/marketplace.json` entry. Always resolves against the curated default git ref (no caller-supplied ref): installing from an unreviewed revision would bypass the marketplace curation boundary and let attacker-controlled code be loaded. Materializes the plugin under `<workspaceDir>/plugins/<name>/`; the assistant must be restarted to load it. Mirrors the CLI's `assistant plugins install <name>`. An already-installed name without `force` returns 409; a name that resolves to nothing returns 404. Sibling to `POST /v1/skills/install`.",
    tags: ["plugins"],
    requestBody: pluginInstallRequestSchema,
    responseBody: pluginInstallResponseSchema,
    additionalResponses: {
      "400": {
        description:
          "The request body was missing `name` or the name failed sanitization.",
      },
      "404": {
        description:
          "No plugin resolves to the given name at the requested ref.",
      },
      "409": {
        description:
          "A plugin with the same name is already installed and `force` was not set.",
      },
    },
    handler: handleInstallPlugin,
  },
  {
    operationId: "plugins_get",
    endpoint: "plugins/:name",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get a plugin's detail view",
    description:
      "Resolve a single plugin's tracked metadata (description, homepage, license, version, source) plus its README markdown. Unions the locally installed copy, the marketplace manifest, and the plugin's repository at the pinned ref — preferring the installed copy. Names that are neither installed nor present in the catalog return 404. Powers the web plugin detail page; mirrors `GET /v1/skills/:id`.",
    tags: ["plugins"],
    pathParams: [
      {
        name: "name",
        type: "string",
        description:
          "Install name. Must match the kebab-case name accepted by `assistant plugins install`.",
      },
    ],
    queryParams: [
      {
        name: "ref",
        schema: { type: "string" },
        description:
          "Optional git ref to read catalog metadata / README at. Defaults to the CLI's `DEFAULT_PLUGIN_REF`.",
      },
    ],
    responseBody: pluginDetailsResponseSchema,
    additionalResponses: {
      "400": {
        description:
          "The plugin name failed sanitization (e.g. contained slashes, dots, or uppercase letters).",
      },
      "404": {
        description:
          "No installed copy and no catalog entry claims the given name.",
      },
    },
    handler: handleGetPluginDetails,
  },
  {
    operationId: "plugins_uninstall",
    endpoint: "plugins/:name",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Uninstall a plugin",
    description:
      "Remove the directory at `<workspaceDir>/plugins/<name>/`. Mirrors the CLI's `assistant plugins uninstall <name>` (without the interactive confirmation — the API caller is responsible for any prompt). The plugin name is sanitized by the same regex the CLI uses; `../escape`-style values, hidden names, and absolute paths return 400. Missing plugins return 404. The assistant must be restarted to drop the plugin from the running runtime.",
    tags: ["plugins"],
    pathParams: [
      {
        name: "name",
        type: "string",
        description:
          "Directory name under `<workspaceDir>/plugins/`. Must match the kebab-case name accepted by `assistant plugins install`.",
      },
    ],
    responseBody: pluginUninstallResponseSchema,
    additionalResponses: {
      "400": {
        description:
          "The plugin name failed sanitization (e.g. contained slashes, dots, or uppercase letters).",
      },
      "404": {
        description: "No plugin directory exists with the given name.",
      },
    },
    handler: handleUninstallPlugin,
  },
  {
    operationId: "plugins_inspect",
    endpoint: "plugins/:name/inspect",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Inspect a plugin's install drift",
    description:
      "Compare the locally installed copy of a plugin against the marketplace's current pinned commit and report whether an upgrade is available. Returns a six-way `status` (`up-to-date`, `update-available`, `not-installed`, `not-in-marketplace`, `unknown-provenance`, `remote-unavailable`) plus the local provenance (installed commit, version, source, and any local edits vs the install-time fingerprint) and the remote pin. An unreachable marketplace for an installed plugin is not fatal — it returns 200 with `status: \"remote-unavailable\"`. A name that is neither installed nor in the catalog returns 404. Powers the web upgrade affordance; mirrors the CLI's `assistant plugins inspect <name>` and `GET /v1/skills/:id/inspect`.",
    tags: ["plugins"],
    pathParams: [
      {
        name: "name",
        type: "string",
        description:
          "Install name. Must match the kebab-case name accepted by `assistant plugins install`.",
      },
    ],
    responseBody: pluginInspectResponseSchema,
    additionalResponses: {
      "400": {
        description:
          "The plugin name failed sanitization (e.g. contained slashes, dots, or uppercase letters).",
      },
      "404": {
        description:
          "No installed copy and no catalog entry claims the given name.",
      },
    },
    handler: handleInspectPlugin,
  },
  {
    operationId: "plugins_versions",
    endpoint: "plugins/:name/versions",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List a plugin's reviewed marketplace pins",
    description: `Report the distinct marketplace pins a plugin has been promoted to over time, newest first (the first entry is the current pin), capped at \`limit\` (default ${DEFAULT_PIN_HISTORY_LIMIT}). The curated \`marketplace.json\` stores only the current pin, so this is reconstructed from the manifest's own commit history on the default branch — every entry is therefore a reviewed, known-good revision. Pair with \`POST /v1/plugins/install\`'s \`pin\` field to roll a plugin back to an older reviewed version. An unknown name (never in the manifest) returns an empty array, not 404.`,
    tags: ["plugins"],
    pathParams: [
      {
        name: "name",
        type: "string",
        description:
          "Install name. Must match the kebab-case name accepted by `assistant plugins install`.",
      },
    ],
    queryParams: [
      {
        name: "limit",
        type: "string",
        required: false,
        description: `Maximum number of pins to return (positive integer; default ${DEFAULT_PIN_HISTORY_LIMIT}).`,
      },
    ],
    responseBody: pluginVersionsResponseSchema,
    additionalResponses: {
      "400": {
        description:
          "The plugin name failed sanitization, or `limit` was not a positive integer.",
      },
      "503": {
        description:
          "The marketplace pin history could not be read from GitHub (rate-limited or upstream error); retryable.",
      },
    },
    handler: handlePluginVersions,
  },
  {
    operationId: "plugins_diff",
    endpoint: "plugins/:name/diff",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Diff a plugin against its install commit",
    description:
      "Show a unified diff of local edits to an installed plugin against the exact commit it was installed at (recorded in its `install-meta.json`). Computing the diff re-materializes the baseline through the install pipeline — a network clone plus a temp-dir write — so this is a POST: it is not a safe, cacheable GET even though it leaves persistent state untouched (requires only `settings.read`). Drift is classified against the install-time fingerprint so an adapter overlay that moved since install never reads as a local change. Returns the baseline `commit`, a `clean` flag, and a `files` array of `{ path, status, diff, binary, reconstructed }` for each modified/added/removed file. The baseline is the install commit, not the marketplace pin — comparing against the current pin is `POST /v1/plugins/:name/upgrade` with `dryRun`. A name with no installed copy returns 404; an install that recorded no commit or fingerprint returns 409; an unreachable source returns 503. Mirrors the CLI's `assistant plugins diff <name>`.",
    tags: ["plugins"],
    pathParams: [
      {
        name: "name",
        type: "string",
        description:
          "Install name. Must match the kebab-case name accepted by `assistant plugins install`.",
      },
    ],
    responseBody: pluginDiffResponseSchema,
    additionalResponses: {
      "400": {
        description:
          "The plugin name failed sanitization (e.g. contained slashes, dots, or uppercase letters).",
      },
      "404": {
        description:
          "No copy of the plugin is installed, or its recorded commit resolves to nothing.",
      },
      "409": {
        description:
          "The install recorded no commit or no fingerprint to re-materialize and verify a baseline from.",
      },
      "503": {
        description:
          "The plugin source (GitHub) was temporarily unavailable; the diff is retryable.",
      },
    },
    handler: handleDiffPlugin,
  },
  {
    operationId: "plugins_upgrade",
    endpoint: "plugins/:name/upgrade",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Upgrade a plugin to the marketplace pin",
    description:
      'Move an installed plugin to the marketplace\'s current pinned commit, re-materializing it under `<workspaceDir>/plugins/<name>/`. Always resolves against the curated marketplace pin (no caller-supplied ref), mirroring `plugins install`\'s curation boundary. A no-op (`outcome: "already-up-to-date"`) when the installed commit already equals the pin; pass `dryRun` to preview the move (`outcome: "would-upgrade"`) without touching the install. Installs lacking provenance are re-pinned to the current SHA. The assistant must be restarted to load the upgraded code. `strategy` controls how local edits are reconciled: `overwrite` (default) discards them and re-installs the pin wholesale; `ours`/`theirs`/`assistant` perform a three-way merge against the re-materialized install commit, carrying non-conflicting edits from both sides forward and resolving conflicting hunks toward the local edit (`ours`) or the pin (`theirs`), or writing git conflict markers into the file and reporting them in `conflicts`/`binaryConflicts` for the assistant to resolve (`assistant`). A merge strategy whose install-time baseline cannot be reconstructed returns 409. Mirrors the CLI\'s `assistant plugins upgrade <name> [--strategy <s>]`.',
    tags: ["plugins"],
    pathParams: [
      {
        name: "name",
        type: "string",
        description:
          "Install name. Must match the kebab-case name accepted by `assistant plugins install`.",
      },
    ],
    requestBody: pluginUpgradeRequestSchema,
    responseBody: pluginUpgradeResponseSchema,
    additionalResponses: {
      "400": {
        description:
          "The plugin name failed sanitization (e.g. contained slashes, dots, or uppercase letters).",
      },
      "404": {
        description:
          "No copy of the plugin is installed, or its source resolves to nothing.",
      },
      "409": {
        description:
          "The install exists but has no marketplace entry to advance to, or a merge strategy was requested whose install-time baseline cannot be reconstructed.",
      },
      "503": {
        description:
          "The plugin source (GitHub) was temporarily unavailable; the upgrade is retryable.",
      },
    },
    handler: handleUpgradePlugin,
  },
  {
    operationId: "plugins_enable",
    endpoint: "plugins/:name/enable",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Enable a plugin",
    description:
      "Enable a plugin in this workspace by removing its `.disabled` sentinel, mirroring the CLI's `assistant plugins enable <name>`. The change is honored live at read time by every tool / injector / hook gate — no restart required. Broadcasts a `sync_changed` invalidation carrying the `plugins:list` tag so other clients refetch `GET /v1/plugins`. An already-enabled plugin returns 409; a name with no plugin directory returns 404 (prefix a default plugin with `default-`); a malformed name returns 400.",
    tags: ["plugins"],
    pathParams: [
      {
        name: "name",
        type: "string",
        description:
          "Directory name under `<workspaceDir>/plugins/`. Prefix a default plugin with `default-`. Must be kebab-case alphanumerics.",
      },
    ],
    responseBody: z.object({ ok: z.boolean() }),
    additionalResponses: {
      "400": {
        description:
          "The plugin name failed validation (not kebab-case alphanumerics).",
      },
      "404": {
        description: "No plugin directory exists with the given name.",
      },
      "409": {
        description: "The plugin is already enabled.",
      },
    },
    handler: handleEnablePlugin,
  },
  {
    operationId: "plugins_disable",
    endpoint: "plugins/:name/disable",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Disable a plugin",
    description:
      "Disable a plugin in this workspace by dropping a `.disabled` sentinel, mirroring the CLI's `assistant plugins disable <name>`. The change is honored live at read time by every tool / injector / hook gate — no restart required. Broadcasts a `sync_changed` invalidation carrying the `plugins:list` tag so other clients refetch `GET /v1/plugins`. An already-disabled plugin returns 409; a user plugin with no directory returns 404 (default plugins are stubbed on demand via the `default-` prefix); a malformed name returns 400.",
    tags: ["plugins"],
    pathParams: [
      {
        name: "name",
        type: "string",
        description:
          "Directory name under `<workspaceDir>/plugins/`. Prefix a default plugin with `default-`. Must be kebab-case alphanumerics.",
      },
    ],
    responseBody: z.object({ ok: z.boolean() }),
    additionalResponses: {
      "400": {
        description:
          "The plugin name failed validation (not kebab-case alphanumerics).",
      },
      "404": {
        description:
          "No plugin directory exists with the given name (user plugins must already be installed).",
      },
      "409": {
        description: "The plugin is already disabled.",
      },
    },
    handler: handleDisablePlugin,
  },
];
