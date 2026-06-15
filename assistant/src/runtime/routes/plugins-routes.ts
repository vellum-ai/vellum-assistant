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
  assertValidSearchPattern,
  filterPluginCatalog,
  InvalidSearchPatternError,
  PluginCatalogUnavailableError,
  type PluginSearchMatch,
} from "../../cli/lib/search-plugins.js";
import {
  PluginNotInstalledError,
  uninstallPlugin,
} from "../../cli/lib/uninstall-plugin.js";
import {
  PluginNotUpgradableError,
  upgradePlugin,
} from "../../cli/lib/upgrade-plugin.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import {
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
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
});

const pluginsListResponseSchema = z.object({
  plugins: z.array(pluginInfoSchema),
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
});

const pluginUpgradeRequestSchema = z.object({
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Report what would change without modifying the install. Defaults to false.",
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
  provenanceWasUnknown: z
    .boolean()
    .describe(
      "Whether the install lacked resolvable provenance before the upgrade; such installs are re-pinned to record it going forward.",
    ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PluginView {
  id: string;
  name: string;
  description: string | null;
  version: string | null;
  path: string;
  issues?: string[];
}

function projectPlugin(entry: InstalledPluginInfo): PluginView {
  // `id` and `name` both track the directory name. `package.json#name` can
  // be scoped (e.g. `@vendor/plugin-name`) which is fine for npm but not
  // what the CLI uses to install — so we don't surface it as `name`.
  const view: PluginView = {
    id: entry.name,
    name: entry.name,
    description: entry.packageJson?.description ?? null,
    version: entry.packageJson?.version ?? null,
    path: entry.target,
  };
  if (entry.issues.length > 0) {
    view.issues = [...entry.issues];
  }
  return view;
}

/** Wire shape for a catalog match. Mirrors {@link pluginSearchMatchSchema}. */
interface PluginMatchView {
  name: string;
  path: string;
  description?: string;
  source: { kind: "github"; repo: string; path?: string; ref: string };
}

/**
 * Re-pack a `readonly` lib match into a mutable wire object so the route
 * serializer's `Record<string, unknown>` contract holds. The wire shape is
 * identical to {@link PluginSearchMatch}.
 */
function projectMatch(m: PluginSearchMatch): PluginMatchView {
  const view: PluginMatchView = {
    name: m.name,
    path: m.path,
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

function handleListPlugins({ queryParams = {} }: RouteHandlerArgs): {
  plugins: PluginView[];
} {
  const q = queryParams.q?.trim();
  const installed = listInstalledPlugins();
  const projected = installed.map(projectPlugin);
  const filtered = q ? projected.filter((p) => matchesQuery(p, q)) : projected;
  return { plugins: filtered };
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
    // Re-pack `readonly` lib types into mutable copies so the route
    // serializer's `Record<string, unknown>` contract holds. The wire
    // shape is identical.
    return {
      query,
      ref: catalog.ref,
      matches: matches.map(projectMatch),
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

async function handleInstallPlugin({ body = {} }: RouteHandlerArgs) {
  const name = typeof body.name === "string" ? body.name : "";
  if (!name) {
    throw new BadRequestError("`name` is required");
  }
  const force = typeof body.force === "boolean" ? body.force : undefined;

  // The ref is pinned to the curated `DEFAULT_PLUGIN_REF` rather than taken
  // from the request: a caller-supplied ref would let any `settings.write`
  // principal install from an unreviewed revision (a PR branch, fork ref,
  // ...) whose marketplace manifest could carry attacker code that the loader
  // then dynamically imports. Installs over HTTP therefore only ever resolve
  // against the reviewed catalog on the default ref. Operators who need
  // another ref use the local CLI's `assistant plugins install --ref`.
  try {
    const result = await installPlugin(
      { name, ref: DEFAULT_PLUGIN_REF, force },
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
// Handler — upgrade
// ---------------------------------------------------------------------------

async function handleUpgradePlugin({
  pathParams = {},
  body = {},
}: RouteHandlerArgs) {
  const rawName = pathParams.name ?? "";
  const dryRun = typeof body.dryRun === "boolean" ? body.dryRun : undefined;

  // Like install, the upgrade target ref is the curated marketplace pin
  // (resolved inside `upgradePlugin` via `inspectPlugin`), never a
  // caller-supplied ref — a `settings.write` principal cannot redirect the
  // upgrade at an unreviewed revision.
  try {
    const result = await upgradePlugin(
      { name: rawName, dryRun },
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
      "Return one entry per directory under `<workspaceDir>/plugins/`, sorted alphabetically. Matches the CLI's `assistant plugins list`. Supports `?q=<text>` for case-insensitive substring matching across plugin id, name, and description.",
    tags: ["plugins"],
    queryParams: [
      {
        name: "q",
        schema: { type: "string" },
        description:
          "Optional substring filter applied to plugin id, name, and description.",
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
    operationId: "plugins_upgrade",
    endpoint: "plugins/:name/upgrade",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Upgrade a plugin to the marketplace pin",
    description:
      'Move an installed plugin to the marketplace\'s current pinned commit, re-materializing it under `<workspaceDir>/plugins/<name>/`. Always resolves against the curated marketplace pin (no caller-supplied ref), mirroring `plugins install`\'s curation boundary. A no-op (`outcome: "already-up-to-date"`) when the installed commit already equals the pin; pass `dryRun` to preview the move (`outcome: "would-upgrade"`) without touching the install. Installs lacking provenance are re-pinned to the current SHA. The assistant must be restarted to load the upgraded code. This does not gate on local edits — callers should consult `GET /v1/plugins/:name/inspect` (`local.localChanges`) first and confirm before overwriting. Mirrors the CLI\'s `assistant plugins upgrade <name>`.',
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
          "The install exists but has no marketplace entry to advance to.",
      },
      "503": {
        description:
          "The plugin source (GitHub) was temporarily unavailable; the upgrade is retryable.",
      },
    },
    handler: handleUpgradePlugin,
  },
];
