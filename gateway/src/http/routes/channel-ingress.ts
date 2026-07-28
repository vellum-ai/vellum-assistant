/**
 * Channel ingress approval endpoints.
 *
 * A declaration is a request, never a grant: an ingress route is served only
 * once the guardian has recorded a decision here. These are deliberately
 * absent from the gateway's IPC surface, which the assistant can reach — a
 * plugin that could approve its own ingress would make the gate meaningless.
 * Guardian auth's loopback fallback still admits a tokenless same-host caller;
 * that is being closed in `edge-guardian` itself rather than worked around.
 *
 * The path segment names the ingress source. Plugins are the only source
 * today, so it resolves against plugin declarations.
 *
 * Mirrors the channel-permission-override routes — same zod / Response.json /
 * error conventions.
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
import { ApproveChannelIngressRequestSchema } from "./channel-ingress-routes.js";

const log = getLogger("channel-ingress");

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Wire schema shared with the published OpenAPI spec (single source).
const ApproveBodySchema = ApproveChannelIngressRequestSchema;

// ---------------------------------------------------------------------------
// POST /v1/channel-ingress/:source/approve — record a decision
// ---------------------------------------------------------------------------

/**
 * The body's digest must match what the source declares right now, so an
 * approval is always a decision about routes the guardian has seen. Without
 * that check a digest could be recorded for routes nobody reviewed, and the
 * grant would take effect the moment some later manifest happened to match.
 */
export function createChannelIngressApproveHandler(
  // Where declarations are read from is not this route's concern; injecting
  // the resolver keeps it decidable without reaching for ambient state.
  resolve: () => PluginIngressResolution = resolvePluginIngress,
) {
  return async (req: Request, source: string): Promise<Response> => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { error: "Request body must be valid JSON" },
        { status: 400 },
      );
    }

    const parsed = ApproveBodySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        {
          error:
            'Invalid request body: "digest" must be a 32-character hex declaration digest',
          issues: parsed.error.issues,
        },
        { status: 400 },
      );
    }
    const { digest } = parsed.data;

    let current;
    try {
      const { approved, pending } = resolve();
      current = [...approved, ...pending].find((d) => d.plugin === source);
    } catch (err) {
      log.error({ err, source }, "Failed to resolve channel ingress");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }

    if (!current) {
      return Response.json(
        { error: `"${source}" declares no ingress routes`, source },
        { status: 404 },
      );
    }
    if (current.digest !== digest) {
      return Response.json(
        {
          error:
            `Digest does not match what "${source}" currently declares. ` +
            `Re-read the declaration and approve that.`,
          source,
          declaredDigest: current.digest,
        },
        { status: 409 },
      );
    }

    try {
      const row = approvePluginIngress({ plugin: source, digest });
      log.info(
        { source, digest, routes: current.routes.length },
        "Guardian approved channel ingress declaration",
      );
      return Response.json({
        source: row.plugin,
        digest: row.digest,
        approvedAt: row.approvedAt,
      });
    } catch (err) {
      log.error({ err, source }, "Failed to record ingress approval");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /v1/channel-ingress/:source/revoke — withdraw a grant
// ---------------------------------------------------------------------------

/**
 * Unlike approve this does not consult the declaration: a grant must be
 * withdrawable even when the manifest that justified it has become unreadable.
 */
export function createChannelIngressRevokeHandler() {
  return async (_req: Request, source: string): Promise<Response> => {
    try {
      const revoked = revokePluginIngressApproval(source);
      if (revoked) {
        log.info({ source }, "Guardian revoked channel ingress approval");
      }
      return Response.json({ source, revoked });
    } catch (err) {
      log.error({ err, source }, "Failed to revoke ingress approval");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}
