/**
 * Route handlers for the assistant plugins surface.
 *
 * GET /v1/plugins         — list installed plugins under `<workspaceDir>/plugins/`.
 * GET /v1/plugins/search  — search the canonical GitHub catalog of installable plugins.
 *
 * Both routes are read-only projections over the same library functions
 * the CLI uses (`assistant plugins list`, `assistant plugins search`),
 * so CLI / daemon / web stay aligned on what an installed or available
 * plugin looks like.
 *
 * Install / uninstall are intentionally not exposed here. The CLI stays
 * the install surface while the on-disk plugin layout firms up.
 *
 * # Policy gating
 *
 * Both routes declare `policyKey: "plugins"` + `requirePolicyEnforcement:
 * true`. The HTTP router enforces via `enforcePolicy()` against the
 * `plugins:GET` / `plugins/search:GET` registry entries in
 * `runtime/auth/route-policy.ts`. The IPC adapter exposes the same
 * policies to the gateway IPC proxy, whose own policy table
 * (`gateway/src/auth/ipc-route-policy.ts`) holds the matching entries
 * for `plugins_list` / `plugins_search`. Both paths require
 * `settings.read`.
 */

import { z } from "zod";

import {
  type InstalledPluginInfo,
  listInstalledPlugins,
} from "../../cli/lib/list-installed-plugins.js";
import {
  InvalidSearchPatternError,
  type PluginSearchMatch,
  searchPlugins,
} from "../../cli/lib/search-plugins.js";
import { BadRequestError, InternalError } from "./errors.js";
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

const pluginSearchMatchSchema = z.object({
  name: z
    .string()
    .describe(
      "Directory name under `experimental/plugins/`. Matches `assistant plugins install <name>`.",
    ),
  path: z
    .string()
    .describe(
      "Repo-relative path of the match (e.g. `experimental/plugins/<name>`).",
    ),
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

function handleListPlugins({
  queryParams = {},
}: RouteHandlerArgs): { plugins: PluginView[] } {
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
  matches: PluginSearchMatch[];
}

async function handleSearchPlugins({
  queryParams = {},
}: RouteHandlerArgs): Promise<PluginsSearchResponse> {
  // Empty string is a legitimate "match everything" query per the lib's
  // contract — accept it without forcing the caller to pick a sentinel.
  const query = queryParams.q ?? "";
  const ref = queryParams.ref?.trim() || undefined;

  try {
    const result = await searchPlugins(
      { query, ref },
      { fetch: globalThis.fetch.bind(globalThis) },
    );
    // Re-pack `readonly` lib types into mutable copies so the route
    // serializer's `Record<string, unknown>` contract holds. The wire
    // shape is identical.
    return {
      query: result.query,
      ref: result.ref,
      matches: result.matches.map((m) => ({ name: m.name, path: m.path })),
    };
  } catch (err) {
    if (err instanceof InvalidSearchPatternError) {
      throw new BadRequestError(err.message);
    }
    throw new InternalError(
      err instanceof Error ? err.message : "plugin catalog search failed",
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
    policyKey: "plugins",
    requirePolicyEnforcement: true,
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
    policyKey: "plugins",
    requirePolicyEnforcement: true,
    summary: "Search the plugin catalog",
    description:
      "List installable plugins from the canonical `vellum-ai/vellum-assistant` catalog at `experimental/plugins/`. The query is an ECMAScript regex matched case-insensitively against the directory name (e.g. `memory`, `^simple`). Empty query returns every entry. Mirrors the CLI's `assistant plugins search`.",
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
];
