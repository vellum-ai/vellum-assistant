/** Guardian approval gate over plugin-declared ingress routes. */

import { createHash } from "node:crypto";

import { listPluginIngressApprovals } from "../db/plugin-ingress-approval-store.js";
import { getLogger } from "../logger.js";
import {
  discoverPluginIngress,
  PluginIngressCache,
  type DiscoveredPluginIngress,
  type DiscoverPluginIngressOptions,
  type IngressRoute,
  type PluginIngressDiscovery,
  type PluginIngressProblem,
} from "./plugin-ingress.js";

const log = getLogger("plugin-ingress-approvals");

/**
 * Digest of what a declaration asks for.
 *
 * Covers reach only — each route's transport, signer, and path,
 * order-independent. A `description` reword leaves the digest alone, so it
 * does not revoke an approval, while adding a route, changing one's
 * transport, or changing whose signature opens it does.
 */
export function ingressDeclarationDigest(
  routes: readonly Pick<IngressRoute, "kind" | "path" | "signer">[],
): string {
  const canonical = routes
    .map((route) => `${route.kind} ${route.signer} ${route.path}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/** A discovered declaration with no matching approval. */
export interface PendingPluginIngress {
  plugin: string;
  routes: readonly IngressRoute[];
  /** Digest a guardian would be approving. */
  digest: string;
}

export interface ApprovedPluginIngress extends DiscoveredPluginIngress {
  digest: string;
}

export interface PluginIngressResolution {
  /** Declarations a guardian has approved, and only these may be served. */
  approved: ApprovedPluginIngress[];
  /**
   * Declarations awaiting a decision. Surfaced so a guardian request can be
   * raised for them; never served.
   */
  pending: PendingPluginIngress[];
  problems: PluginIngressProblem[];
}

/**
 * Discover plugin declarations and split them by approval.
 *
 * Approvals live in the gateway database, which the assistant cannot
 * write. That separation is the point: the assistant authors the
 * declaration, and only a guardian decision recorded here turns it into a
 * grant.
 *
 * Editing a manifest changes its digest and drops the plugin back to
 * `pending`, so an approval covers the routes it was granted for and not
 * whatever replaces them.
 */
export function resolvePluginIngress(
  opts: DiscoverPluginIngressOptions = {},
): PluginIngressResolution {
  return resolveDiscoveredPluginIngress(discoverPluginIngress(opts));
}

/**
 * Shared TTL cache behind {@link resolveCachedPluginIngress}. Module-global
 * so every caller sees one snapshot and one refresh schedule.
 */
const ingressCache = new PluginIngressCache();

/**
 * Approved-ingress view for the request path.
 *
 * Reads through the TTL cache rather than re-walking the plugins directory
 * per inbound webhook, while installs and toggles still take effect without
 * a gateway restart. Approvals are read from the database each call — the
 * table is small, and a stale grant is the one thing worth never caching.
 */
export function resolveCachedPluginIngress(): PluginIngressResolution {
  return resolveDiscoveredPluginIngress(ingressCache.get());
}

/** Split an already-performed discovery by approval. */
function resolveDiscoveredPluginIngress(
  discovery: PluginIngressDiscovery,
): PluginIngressResolution {
  const { plugins, problems } = discovery;
  const approvedDigestByPlugin = new Map(
    listPluginIngressApprovals().map((a) => [a.plugin, a.digest]),
  );

  const approved: ApprovedPluginIngress[] = [];
  const pending: PendingPluginIngress[] = [];

  for (const discovered of plugins) {
    const digest = ingressDeclarationDigest(discovered.routes);
    if (approvedDigestByPlugin.get(discovered.plugin) === digest) {
      approved.push({ ...discovered, digest });
    } else {
      pending.push({
        plugin: discovered.plugin,
        routes: discovered.routes,
        digest,
      });
    }
  }

  if (pending.length > 0) {
    log.info(
      { pending: pending.map((p) => ({ plugin: p.plugin, digest: p.digest })) },
      "Plugin ingress declarations awaiting guardian approval",
    );
  }

  return { approved, pending, problems };
}
