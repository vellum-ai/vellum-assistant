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
  type IngressRouteKind,
  type PluginIngressDiscovery,
  type PluginIngressProblem,
} from "./plugin-ingress.js";

const log = getLogger("plugin-ingress-approvals");

/**
 * Digest of what a declaration asks for.
 *
 * Covers reach only — each route's transport, signer, handshake scheme, and
 * path, order-independent. A `description` reword leaves the digest alone, so
 * it does not revoke an approval, while adding a route, changing one's
 * transport, changing whose signature opens it, or moving it to a scheme that
 * exposes it differently all do.
 *
 * A route on the default `signed-headers` scheme is encoded without that
 * field, exactly as it was before the field existed. The alternative is that
 * introducing `handshake` silently re-digests every unchanged manifest, drops
 * each one back to `pending`, and 404s routes a guardian already approved
 * until someone approves them again. Omitting the default is unambiguous
 * because a path may not contain whitespace (see `IngressRouteSchema`), so a
 * three-token line can never be read as a four-token one.
 */
export function ingressDeclarationDigest(
  routes: readonly Pick<
    IngressRoute,
    "kind" | "path" | "signer" | "handshake"
  >[],
): string {
  const canonical = routes
    .map((route) =>
      route.handshake === "signed-headers"
        ? `${route.kind} ${route.signer} ${route.path}`
        : `${route.kind} ${route.signer} ${route.handshake} ${route.path}`,
    )
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
  /** Declarations a guardian has approved. */
  approved: ApprovedPluginIngress[];
  /**
   * Declarations awaiting a decision. Served only where {@link
   * findServableRoute} says a decision is not required.
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

/**
 * The declared route the gateway may serve at `plugin`/`path`, if any.
 *
 * Approval is the general gate, with one exception: a route declaring
 * `signer: "vellum"` is served without it. Such a route only opens to a
 * caller holding the platform's own webhook secret, which is to say us, and
 * the user extended that trust when they connected their account, so asking
 * them to approve it again buys nothing. A route signed by anyone else still
 * needs a guardian decision, because approval is what establishes who that
 * signer is allowed to be.
 *
 * Note this is reach the plugin can grant itself: a manifest can name a
 * `vellum`-signed path and have it served unreviewed. What it gets is a path
 * only Vellum can drive, carrying no authority over the assistant and
 * nothing a plugin could not already reach by running its own code.
 *
 * Declarations that failed validation are in `problems` and are never
 * servable, regardless of signer.
 */
export function findServableRoute(
  resolution: PluginIngressResolution,
  plugin: string,
  path: string,
  kind: IngressRouteKind,
): IngressRoute | undefined {
  const matches = (routes: readonly IngressRoute[]) =>
    routes.find((route) => route.kind === kind && route.path === path);

  const approved = resolution.approved.find((d) => d.plugin === plugin);
  const fromApproved = approved && matches(approved.routes);
  if (fromApproved) {
    return fromApproved;
  }

  const pending = resolution.pending.find((d) => d.plugin === plugin);
  const fromPending = pending && matches(pending.routes);
  return fromPending?.signer === "vellum" ? fromPending : undefined;
}
