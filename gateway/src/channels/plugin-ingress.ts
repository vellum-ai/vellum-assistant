/**
 * Discovery of plugin-declared public ingress routes.
 *
 * A plugin that needs inbound traffic — a webhook, a provider dialling a
 * realtime socket — cannot reach the public surface today. Every public
 * route in the gateway is hand-written and the Velay path allowlist is a
 * frozen literal, which works for first-party integrations (someone edits
 * the gateway when they add one) but not for a plugin, which ships
 * separately and cannot patch a frozen array. The workaround has been for
 * the plugin to stand up its own tunnel and public address.
 *
 * Instead a plugin declares what it needs in a static file on the
 * workspace volume the gateway already reads:
 *
 *     <workspaceDir>/plugins/<plugin>/channels/ingress.json
 *
 *     {
 *       "routes": [
 *         { "path": "realtime", "kind": "websocket", "description": "…" }
 *       ]
 *     }
 *
 * and the gateway composes the public path from the plugin's own name:
 *
 *     /webhooks/plugins/<plugin>/<path>
 *
 * The file is inert data, never code: the gateway must not execute
 * assistant-supplied logic to find out what to expose.
 *
 * ## What this module does and does not do
 *
 * It discovers and validates declarations. It does **not** serve them. A
 * declaration is a request, not a grant — routing them requires a guardian
 * approval gate that does not exist yet, so nothing here is wired into the
 * request path.
 *
 * ## Trust
 *
 * Everything below treats the manifest as untrusted input from the
 * assistant, because that is what it is. The plugin repo validating its
 * own file is a convenience for its authors, not a guarantee to us.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { getLogger } from "../logger.js";
import { getWorkspaceDir } from "../paths.js";

const log = getLogger("plugin-ingress");

/** Reserved namespace every plugin webhook is composed under. */
export const PLUGIN_WEBHOOK_PREFIX = "/webhooks/plugins";

/** Manifest location relative to a plugin's workspace directory. */
export const PLUGIN_INGRESS_MANIFEST_RELPATH = join("channels", "ingress.json");

/**
 * Transport a declared route expects. The gateway bridges HTTP and
 * WebSocket differently (`velay/http-bridge.ts` vs `websocket-bridge.ts`),
 * so it has to know which before a connection arrives.
 */
export const IngressRouteKindSchema = z.enum(["http", "websocket"]);
export type IngressRouteKind = z.infer<typeof IngressRouteKindSchema>;

/**
 * A plugin directory name that is safe to place in a public URL.
 *
 * The directory name becomes a path segment, so it is validated rather
 * than trusted: anything that could alter the shape of the composed path
 * is rejected outright.
 */
const SAFE_PLUGIN_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

export const IngressRouteSchema = z.object({
  /**
   * Path relative to the plugin's own namespace — `"realtime"`, not
   * `/webhooks/plugins/meeting-bot/realtime`. The plugin never writes the
   * prefix, so it cannot name another plugin's route: cross-plugin
   * interception is unrepresentable rather than something we have to
   * detect.
   *
   * `.` and `..` segments are rejected because Velay percent-decodes and
   * runs `path.Clean` on the inbound path before matching its allowlist
   * (see `IsPathAllowed` in the platform repo). A declared
   * `../other/steal` would otherwise compose to a path that cleans out of
   * the declaring plugin's namespace. A trailing slash is rejected for
   * the same reason — `path.Clean` strips it, so a composed path ending
   * in one could never match.
   */
  path: z
    .string()
    .min(1)
    .regex(
      /^[^/?#\s][^?#\s]*$/,
      "path must be relative (no leading slash) and free of query/fragment",
    )
    .refine((p) => !p.endsWith("/"), {
      message: "path must not end in a trailing slash",
    })
    .refine((p) => !p.split("/").some((seg) => seg === "." || seg === ".."), {
      message: "path must not contain . or .. segments",
    }),
  kind: IngressRouteKindSchema,
  /** Human-readable purpose, surfaced in gateway logs and admin UI. */
  description: z.string().min(1),
});
export type IngressRoute = z.infer<typeof IngressRouteSchema>;

/**
 * The declaration itself.
 *
 * No version and no plugin name. The format is ours, not something a
 * plugin versions independently, and the plugin's identity is already
 * known from the directory the file was read from — taking it from the
 * file content would let a manifest claim to be a different plugin.
 */
export const PluginIngressManifestSchema = z.object({
  routes: z.array(IngressRouteSchema).min(1),
});
export type PluginIngressManifest = z.infer<typeof PluginIngressManifestSchema>;

/** One plugin's validated declaration. */
export interface DiscoveredPluginIngress {
  plugin: string;
  routes: readonly IngressRoute[];
}

/** A declaration that was found but could not be used, and why. */
export interface PluginIngressProblem {
  plugin: string;
  reason: string;
}

export interface PluginIngressDiscovery {
  plugins: DiscoveredPluginIngress[];
  /**
   * Rejected declarations. Surfaced rather than thrown: one plugin's
   * malformed file must never take down discovery for every other plugin.
   */
  problems: PluginIngressProblem[];
}

/** Compose the absolute public path the gateway serves for a route. */
export function pluginWebhookPath(plugin: string, path: string): string {
  return `${PLUGIN_WEBHOOK_PREFIX}/${plugin}/${path.replace(/^\/+/, "")}`;
}

/** Absolute paths a discovered plugin is asking us to expose. */
export function ingressRoutePaths(
  discovered: DiscoveredPluginIngress,
): string[] {
  return discovered.routes.map((route) =>
    pluginWebhookPath(discovered.plugin, route.path),
  );
}

/** Parse and validate one manifest's contents. Throws on invalid input. */
export function parsePluginIngressManifest(
  raw: unknown,
): PluginIngressManifest {
  const manifest = PluginIngressManifestSchema.parse(raw);
  const seen = new Set<string>();
  for (const route of manifest.routes) {
    if (seen.has(route.path)) {
      throw new Error(`duplicate route ${route.path}`);
    }
    seen.add(route.path);
  }
  return manifest;
}

export interface DiscoverPluginIngressOptions {
  /** Workspace root. Defaults to {@link getWorkspaceDir}. */
  workspaceDir?: string;
}

/**
 * Scan the workspace for plugin ingress declarations.
 *
 * Skips plugins carrying a `.disabled` sentinel — the same source of truth
 * the assistant uses for hooks, tools, and routes. Without this, disabling
 * a plugin would leave its public routes live.
 *
 * Note that only workspace-installed plugins are visible here. Default
 * plugins ship inside the assistant binary, which the gateway cannot read,
 * so they cannot declare ingress by this route.
 */
export function discoverPluginIngress(
  opts: DiscoverPluginIngressOptions = {},
): PluginIngressDiscovery {
  const workspaceDir = opts.workspaceDir ?? getWorkspaceDir();
  const pluginsDir = join(workspaceDir, "plugins");
  const plugins: DiscoveredPluginIngress[] = [];
  const problems: PluginIngressProblem[] = [];

  let entries: string[];
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // No plugins directory at all is the normal empty case, not an error.
    return { plugins, problems };
  }

  for (const plugin of entries) {
    if (!SAFE_PLUGIN_NAME.test(plugin)) {
      // Never report a name we would not serve — it lands in logs.
      problems.push({
        plugin: JSON.stringify(plugin),
        reason: "plugin directory name is not a safe URL path segment",
      });
      continue;
    }

    const pluginDir = join(pluginsDir, plugin);
    if (existsSync(join(pluginDir, ".disabled"))) continue;

    const manifestPath = join(pluginDir, PLUGIN_INGRESS_MANIFEST_RELPATH);
    if (!existsSync(manifestPath)) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (err) {
      problems.push({
        plugin,
        reason: `unreadable or malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    try {
      const manifest = parsePluginIngressManifest(raw);
      plugins.push({ plugin, routes: manifest.routes });
    } catch (err) {
      problems.push({
        plugin,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (problems.length > 0) {
    log.warn(
      { problems },
      "Ignored plugin ingress declarations that failed validation",
    );
  }

  return { plugins, problems };
}

/** Default staleness window for {@link PluginIngressCache}. */
const DEFAULT_TTL_MS = 5000;

/**
 * TTL-cached view of {@link discoverPluginIngress}.
 *
 * Discovery walks the filesystem, so the request path should not repeat it
 * per connection. The TTL means installing, enabling, or disabling a
 * plugin takes effect without a gateway restart — the same
 * read-through-with-staleness contract as {@link ConfigFileCache}.
 */
export class PluginIngressCache {
  private readonly ttlMs: number;
  private readonly workspaceDir: string | undefined;
  private snapshot: PluginIngressDiscovery = { plugins: [], problems: [] };
  private lastReadAt = 0;

  constructor(opts?: { ttlMs?: number; workspaceDir?: string }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.workspaceDir = opts?.workspaceDir;
  }

  /** Current discovery, refreshed if the snapshot is stale. */
  get(opts?: { force?: boolean }): PluginIngressDiscovery {
    const now = Date.now();
    if (opts?.force || now - this.lastReadAt >= this.ttlMs) {
      this.snapshot = discoverPluginIngress({
        workspaceDir: this.workspaceDir,
      });
      this.lastReadAt = Date.now();
    }
    return this.snapshot;
  }

  /** Force a re-scan on the next {@link get}. */
  invalidate(): void {
    this.lastReadAt = 0;
  }
}
