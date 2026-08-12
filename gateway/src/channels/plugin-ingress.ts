/** Discovery of plugin-declared public ingress routes from the workspace volume. */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";

import { z } from "zod";

import { getLogger } from "../logger.js";
import { getWorkspaceDir } from "../paths.js";
import { IngressInboundSchema } from "./ingress-inbound.js";
import { IngressVerificationSchema } from "./ingress-verification.js";

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

/**
 * Where the caller carries its signature. Selects the scheme, never whether
 * one is required — an unsigned plugin route does not exist.
 */
export const IngressHandshakeSchema = z.enum([
  "signed-headers",
  "signed-query",
]);
export type IngressHandshake = z.infer<typeof IngressHandshakeSchema>;

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
  /**
   * How the caller proves it holds the signing secret.
   *
   * `signed-headers` (the default) is the platform's scheme: the signature
   * travels in `Vellum-Signature`, over the body for HTTP and over
   * `<timestamp>.<pathname>` for a WebSocket upgrade.
   *
   * `signed-query` puts the same HMAC in the URL instead, for a caller that
   * is handed a URL and nothing else. Recall.ai's realtime endpoint is the
   * case that forced it: a third party dialing a socket has no place to put a
   * header. The tradeoff is that such a URL is a bearer credential until it
   * expires, which is why it carries an expiry the minter chooses and the
   * scheme bounds (`@vellumai/service-contracts/plugin-ingress-handshake`).
   *
   * WebSocket only. An HTTP route declaring it is rejected: an HTTP request
   * always has somewhere to put a header, so the weaker scheme would buy
   * nothing.
   *
   * Part of the digest, so a route cannot move between schemes under an
   * approval a guardian granted for the other one.
   */
  handshake: IngressHandshakeSchema.default("signed-headers"),
  /**
   * How a third-party caller's signature is checked, when it is not ours.
   *
   * Absent (the default) means the platform scheme: `Vellum-Signature` over
   * the body, keyed by whichever `webhook_secret` {@link signer} selects.
   * That is right for a caller Vellum controls and wrong for every other one
   * — Comms signs `X-Osis-Signature`, Photon signs `X-Spectrum-Signature` over
   * a timestamped preamble, and neither can be asked to sign ours.
   *
   * Present, the route is verified by the descriptor instead: the gateway
   * runs one HMAC engine and reads the vendor's specifics as data, so a new
   * vendor is a manifest edit rather than gateway code. See
   * `ingress-verification.ts` for the scheme and for what stays gateway-side.
   *
   * The descriptor supersedes {@link signer} — it names its own credential
   * field, under this plugin's own service — so declaring it alongside
   * `signer: "vellum"` is rejected: `vellum` routes are served without a
   * guardian approval (see `findServableRoute`), and a route that both skips
   * approval and verifies against a secret the plugin chose would be reach a
   * plugin grants itself. HTTP only, for the same reason `signed-query` is
   * WebSocket only: a socket upgrade is bridged elsewhere and carries none of
   * this.
   *
   * Part of the digest, so what verifies a route cannot change under an
   * approval granted for something else.
   */
  verification: IngressVerificationSchema.optional(),
  /**
   * That this route's replies carry inbound messages, and how to read them.
   *
   * Absent (the default) means the route is a webhook and nothing more: the
   * gateway forwards the delivery, returns whatever the plugin answered, and
   * the message goes no further. Present, the plugin's reply is normalized and
   * run through the gateway's inbound pipeline — admission floor, trust
   * verdict, the verification and invite intercepts — exactly as a built-in
   * channel's would be. See `ingress-inbound.ts` for the declaration and
   * `plugin-inbound.ts` for what the gateway supplies rather than reads.
   *
   * Rejected alongside `signer: "vellum"`. A `vellum`-signed route is served
   * without a guardian approval (see `findServableRoute`), which is defensible
   * for a path only Vellum can drive and carrying no authority over the
   * assistant. Delivering messages *is* such authority — it is how a
   * conversation starts — so a route that both skips approval and injects
   * turns would be reach a plugin grants itself. HTTP only, for the same
   * reason `verification` is: a socket upgrade is bridged elsewhere and has no
   * reply to read.
   *
   * Part of the digest, so a route cannot begin delivering messages, or begin
   * reading them differently, under an approval granted for something else.
   */
  inbound: IngressInboundSchema.optional(),
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
    // Rejected here rather than in the schema so the whole declaration fails
    // with one message, the same way a duplicate path does.
    if (route.handshake === "signed-query" && route.kind !== "websocket") {
      throw new Error(
        `route ${route.path}: signed-query handshakes are only valid for websocket routes`,
      );
    }
    if (route.verification) {
      if (route.signer === "vellum") {
        throw new Error(
          `route ${route.path}: declared verification cannot be combined with signer "vellum"`,
        );
      }
      if (route.kind !== "http") {
        throw new Error(
          `route ${route.path}: declared verification is only valid for http routes`,
        );
      }
    }
    if (route.inbound) {
      if (route.signer === "vellum") {
        throw new Error(
          `route ${route.path}: inbound delivery cannot be combined with signer "vellum"`,
        );
      }
      if (route.kind !== "http") {
        throw new Error(
          `route ${route.path}: inbound delivery is only valid for http routes`,
        );
      }
    }
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
