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
  findServableRoute,
  resolvePluginIngress,
  type PluginIngressResolution,
} from "../../channels/plugin-ingress-approvals.js";
import type { IngressVerification } from "../../channels/ingress-verification.js";
import {
  pluginWebhookPath,
  type IngressRoute,
} from "../../channels/plugin-ingress.js";
import { credentialKey } from "../../credential-key.js";
import {
  approvePluginIngress,
  listPluginIngressApprovals,
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
// GET /v1/channel-ingress: what has been declared, and what is being served
// ---------------------------------------------------------------------------

/**
 * The parts of a declared scheme a guardian listing can show.
 *
 * HMAC names its own algorithm and header. Standard Webhooks always signs
 * with sha256 and always presents the digest in `webhook-signature`, so
 * those values are filled in rather than stored on the descriptor.
 */
function verificationView(verification: IngressVerification): {
  algorithm: string;
  signatureHeader: string;
} {
  if (verification.kind === "standard-webhooks") {
    return {
      algorithm: "sha256",
      signatureHeader: "webhook-signature",
    };
  }
  return {
    algorithm: verification.algorithm,
    signatureHeader: verification.signature.header,
  };
}

/**
 * One route, as the guardian needs to read it.
 *
 * `publicPath` is what would open on the public surface, which is the reach
 * being granted and is not otherwise derivable without knowing how the gateway
 * composes it. `credential` names the secret the route verifies against, so a
 * declaration approved but 409ing on a missing secret is diagnosable from the
 * same view. The verification descriptor is summarised rather than echoed
 * whole: the algorithm, the header a signature arrives in, and which credential
 * keys it are what a decision turns on.
 *
 * `served` is answered by asking `findServableRoute` the same question the
 * request path asks, rather than by restating its rule. A `signer: "vellum"`
 * route is served out of a pending declaration, so approval state alone does
 * not say whether a route is live, and a listing that reimplemented the
 * exception could come to disagree with the surface it describes.
 *
 * `deliversInbound` is the difference between a route that receives a callback
 * and one that starts conversations. They are not the same grant and a guardian
 * deciding about the second should be told so, so it is reported rather than
 * left to be inferred from a `description` the plugin wrote.
 */
function routeView(
  resolution: PluginIngressResolution,
  plugin: string,
  route: IngressRoute,
) {
  return {
    path: route.path,
    publicPath: pluginWebhookPath(plugin, route.path),
    kind: route.kind,
    signer: route.signer,
    handshake: route.handshake,
    description: route.description,
    served:
      findServableRoute(resolution, plugin, route.path, route.kind) !==
      undefined,
    deliversInbound: route.inbound !== undefined,
    credential: route.verification
      ? credentialKey(plugin, route.verification.secret.field)
      : credentialKey(
          route.signer === "vellum" ? "vellum" : plugin,
          "webhook_secret",
        ),
    verification: route.verification
      ? verificationView(route.verification)
      : undefined,
  };
}

/**
 * Every declaration the gateway can see, with its state.
 *
 * Without this a guardian has no way to learn that something is waiting, nor
 * the digest they would have to approve. The pending state is otherwise
 * visible only in a gateway log line, and a route held back by it 404s exactly
 * like one nobody declared. That is right for the public surface, where the
 * caller is anyone on the internet, and wrong here.
 *
 * `state` is the approval state and nothing more, because approval and
 * servability are not the same question: a `signer: "vellum"` route is served
 * out of a pending declaration. Each route carries its own `served`, so a
 * source can report accurately that it is waiting on a decision while some of
 * what it declared is already live.
 *
 * `pending` covers two situations worth telling apart, so a source that holds a
 * grant for some earlier manifest reports the digest it was granted for under
 * `approvedDigest`: an edited declaration reads as "approve the new one", not
 * as "this was never approved".
 *
 * Declarations that failed validation are reported too. They are unservable
 * regardless of approval, and a guardian looking for a route that is missing
 * needs to see the reason rather than an absence.
 */
export function createChannelIngressListHandler(
  resolve: () => PluginIngressResolution = resolvePluginIngress,
) {
  return async (): Promise<Response> => {
    try {
      const resolution = resolve();
      const { approved, pending, problems } = resolution;
      const approvals = new Map(
        listPluginIngressApprovals().map((a) => [a.plugin, a]),
      );
      const routes = (plugin: string, declared: readonly IngressRoute[]) =>
        declared.map((r) => routeView(resolution, plugin, r));

      return Response.json({
        sources: [
          ...approved.map((d) => ({
            source: d.plugin,
            state: "approved" as const,
            digest: d.digest,
            approvedAt: approvals.get(d.plugin)?.approvedAt,
            routes: routes(d.plugin, d.routes),
          })),
          ...pending.map((d) => ({
            source: d.plugin,
            state: "pending" as const,
            digest: d.digest,
            approvedDigest: approvals.get(d.plugin)?.digest,
            routes: routes(d.plugin, d.routes),
          })),
        ],
        problems: problems.map((p) => ({ source: p.plugin, reason: p.reason })),
      });
    } catch (err) {
      log.error({ err }, "Failed to resolve channel ingress");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

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
