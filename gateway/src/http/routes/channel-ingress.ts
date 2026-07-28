/**
 * Guardian-only approval of declared public ingress routes.
 *
 * A declaration is a request, never a grant: an ingress route is served only
 * once the guardian has recorded a decision here. The routes are deliberately
 * absent from the gateway's IPC surface, which the assistant can reach — a
 * plugin that could approve its own ingress would make the gate meaningless.
 * Guardian auth's loopback fallback still admits a tokenless same-host caller;
 * that is being closed in `edge-guardian` itself rather than worked around.
 *
 * Plugins are the only source of declarations today, hence the
 * `/plugins/{plugin}` segment; another source would sit beside it rather than
 * change this path.
 */

import {
  resolvePluginIngress,
  type PluginIngressResolution,
} from "../../channels/plugin-ingress-approvals.js";
import {
  approvePluginIngress,
  revokePluginIngressApproval,
} from "../../db/plugin-ingress-approval-store.js";
import { getLogger } from "../../logger.js";

const log = getLogger("channel-ingress");

/** Digest as produced by `ingressDeclarationDigest` — 32 hex chars. */
const DIGEST_PATTERN = /^[0-9a-f]{32}$/;

/**
 * PUT /v1/channel-ingress/plugins/:plugin — approve a declaration.
 *
 * The body's digest must match what the plugin declares right now, so an
 * approval is always a decision about routes the guardian has seen. Without
 * that check a digest could be recorded for routes nobody reviewed, and the
 * grant would take effect the moment some later manifest happened to match.
 */
export function createChannelIngressApproveHandler(
  // Where declarations are read from is not this route's concern; injecting
  // the resolver keeps it decidable without reaching for ambient state.
  resolve: () => PluginIngressResolution = resolvePluginIngress,
) {
  return async (req: Request, plugin: string): Promise<Response> => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { error: "Request body must be valid JSON" },
        { status: 400 },
      );
    }

    const digest = (body as { digest?: unknown })?.digest;
    if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) {
      return Response.json(
        { error: '"digest" must be a 32-character hex declaration digest' },
        { status: 400 },
      );
    }

    let current;
    try {
      const { approved, pending } = resolve();
      current = [...approved, ...pending].find((d) => d.plugin === plugin);
    } catch (err) {
      log.error({ err, plugin }, "Failed to resolve plugin ingress");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }

    if (!current) {
      return Response.json(
        { error: `Plugin "${plugin}" declares no ingress routes`, plugin },
        { status: 404 },
      );
    }
    if (current.digest !== digest) {
      return Response.json(
        {
          error:
            `Digest does not match what "${plugin}" currently declares. ` +
            `Re-read the declaration and approve that.`,
          plugin,
          declaredDigest: current.digest,
        },
        { status: 409 },
      );
    }

    try {
      const row = approvePluginIngress({ plugin, digest });
      log.info(
        { plugin, digest, routes: current.routes.length },
        "Guardian approved plugin ingress declaration",
      );
      return Response.json({
        plugin: row.plugin,
        digest: row.digest,
        approvedAt: row.approvedAt,
      });
    } catch (err) {
      log.error({ err, plugin }, "Failed to record ingress approval");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

/**
 * DELETE /v1/channel-ingress/plugins/:plugin — revoke a grant.
 *
 * Unlike approve this does not consult the declaration: a grant must be
 * withdrawable even when the plugin's manifest has since become unreadable.
 */
export function createChannelIngressRevokeHandler() {
  return async (_req: Request, plugin: string): Promise<Response> => {
    try {
      const revoked = revokePluginIngressApproval(plugin);
      if (revoked) {
        log.info({ plugin }, "Guardian revoked plugin ingress approval");
      }
      return Response.json({ plugin, revoked });
    } catch (err) {
      log.error({ err, plugin }, "Failed to revoke ingress approval");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}
