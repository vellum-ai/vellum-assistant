/** Discovery of plugin-declared public ingress routes from the workspace volume. */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";

import { z } from "zod";

import { getLogger } from "../logger.js";
import { getWorkspaceDir } from "../paths.js";

const log = getLogger("plugin-ingress");

/** Reserved namespace every plugin webhook is composed under. */
export const PLUGIN_WEBHOOK_PREFIX = "/webhooks/plugins";

/** Manifest location relative to a plugin's workspace directory. */
export const PLUGIN_INGRESS_MANIFEST_RELPATH = join("channels", "ingress.json");

/**
 * Transport a declared route expects. HTTP and WebSocket are bridged
 * differently (`velay/http-bridge.ts` vs `velay/websocket-bridge.ts`), so
 * the kind has to be known before a connection arrives.
 */
export const IngressRouteKindSchema = z.enum(["http", "websocket"]);
export type IngressRouteKind = z.infer<typeof IngressRouteKindSchema>;

/**
 * Party whose `webhook_secret` must have signed an inbound request. Every
 * public plugin route is signature-checked; this only selects the key.
 */
export const IngressSignerSchema = z.enum(["plugin", "vellum"]);
export type IngressSigner = z.infer<typeof IngressSignerSchema>;

/** Plugin directory name usable as a public URL path segment. */
const SAFE_PLUGIN_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * A path is canonical when percent-decoding and POSIX normalization both
 * leave it unchanged.
 *
 * Velay percent-decodes and `path.Clean`s an inbound path before matching
 * it against the allowlist, so a non-canonical declaration is served under
 * a different path than the one declared: `%2e%2e/other/hook` decodes out
 * of the declaring plugin's namespace, and `a//b` cleans to `a/b`,
 * colliding with a separate `a/b` declaration that the exact-string
 * duplicate check treats as distinct.
 */
function isCanonicalPath(value: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Malformed percent-encoding — Velay's decode would fail or differ.
    return false;
  }
  return decoded === value && posix.normalize(value) === value;
}

export const IngressRouteSchema = z.object({
  /**
   * Path relative to the plugin's own namespace — `"realtime"`, not
   * `/webhooks/plugins/meeting-bot/realtime`. The prefix and the plugin
   * name are supplied by the gateway, so a declaration cannot name another
   * plugin's route.
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
    .refine(isCanonicalPath, {
      message:
        "path must be canonical: unencoded, with no empty, '.' or redundant segments",
    })
    .refine((p) => !p.split("/").some((seg) => seg === "." || seg === ".."), {
      message: "path must not contain . or .. segments",
    }),
  kind: IngressRouteKindSchema,
  /**
   * Whose secret signs requests to this route.
   *
   * `plugin` (the default) verifies against the plugin's own
   * `webhook_secret`, so a plugin can receive third-party callbacks it has
   * arranged itself, and a guardian decides whether that route is served.
   *
   * `vellum` verifies against the platform's `webhook_secret`, for routes
   * only Vellum calls, which would otherwise need a per-plugin secret
   * provisioned for a caller we already authenticate. Such a route is
   * served without a guardian approval: the trust it relies on was given
   * when the account was connected. See `findServableRoute` in
   * `plugin-ingress-approvals.ts` for the rule and what it concedes.
   *
   * Either way the signer is part of the digest, so a plugin cannot move a
   * route between the two without the change being visible.
   */
  signer: IngressSignerSchema.default("plugin"),
  /** Human-readable purpose, surfaced in gateway logs and admin UI. */
  description: z.string().min(1),
});
export type IngressRoute = z.infer<typeof IngressRouteSchema>;

/**
 * A plugin's declaration. The plugin's identity comes from the directory
 * the file is read from, not from its contents, so a manifest cannot claim
 * to belong to a different plugin.
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

/** A declaration that was found but rejected, and why. */
export interface PluginIngressProblem {
  plugin: string;
  reason: string;
}

export interface PluginIngressDiscovery {
  plugins: DiscoveredPluginIngress[];
  /**
   * Rejected declarations, reported rather than thrown so that one
   * malformed manifest cannot suppress discovery for every other plugin.
   */
  problems: PluginIngressProblem[];
}

/**
 * Matches a public plugin route path, capturing plugin name and route path.
 * Shared by the HTTP route entry and the WebSocket upgrade branch so the two
 * halves of the surface cannot come to disagree about its shape.
 */
export const PLUGIN_WEBHOOK_PATH_PATTERN =
  /^\/webhooks\/plugins\/([^/]+)\/(.+)$/;

/** Compose the absolute public path the gateway serves for a route. */
export function pluginWebhookPath(plugin: string, path: string): string {
  return `${PLUGIN_WEBHOOK_PREFIX}/${plugin}/${path.replace(/^\/+/, "")}`;
}

/** Absolute paths a discovered plugin is asking the gateway to expose. */
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
 * A manifest is untrusted input from the assistant and is validated here
 * independently of any checks the plugin performs on itself.
 *
 * Plugins carrying a `.disabled` sentinel are skipped, matching the source
 * of truth the assistant uses for hooks, tools, and routes, so a disabled
 * plugin holds no public routes.
 *
 * Only workspace-installed plugins are visible. Default plugins ship
 * inside the assistant binary, which the gateway cannot read.
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
    entries = readdirSync(pluginsDir);
  } catch {
    // An absent plugins directory is the empty case, not a failure.
    return { plugins, problems };
  }

  for (const plugin of entries) {
    const pluginDir = join(pluginsDir, plugin);
    try {
      // statSync rather than Dirent.isDirectory so plugins installed as
      // symlinked roots are seen, matching the assistant's own plugin scan.
      if (!statSync(pluginDir).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    // A directory only counts as a plugin when it carries a package.json,
    // the same gate the assistant's scan applies. Without it a symlink to
    // any directory holding an ingress manifest would hold public routes
    // for something the assistant never loads.
    if (!existsSync(join(pluginDir, "package.json"))) {
      continue;
    }

    if (!SAFE_PLUGIN_NAME.test(plugin)) {
      problems.push({
        // Quoted so an unservable name is unambiguous in logs.
        plugin: JSON.stringify(plugin),
        reason: "plugin directory name is not a safe URL path segment",
      });
      continue;
    }

    if (existsSync(join(pluginDir, ".disabled"))) {
      continue;
    }

    const manifestPath = join(pluginDir, PLUGIN_INGRESS_MANIFEST_RELPATH);
    if (!existsSync(manifestPath)) {
      continue;
    }

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
 * TTL-cached view of {@link discoverPluginIngress}, so the request path
 * does not re-walk the filesystem per connection and plugin installs or
 * toggles take effect without a gateway restart.
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
