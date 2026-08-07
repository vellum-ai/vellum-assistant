import { z } from "zod";

import type { GatewayRouteDefinition } from "./types.js";

/**
 * OpenAPI route metadata for the channel-ingress approval API.
 *
 * These schemas are the codegen source of truth (see
 * scripts/generate-openapi.ts). Unlike the neighbouring channel APIs there
 * are no assistant-scoped `/v1/assistants/{assistant_id}/...` variants: the
 * guardian reaches these flat paths directly rather than through the
 * platform proxy.
 *
 * The handlers live in `channel-ingress.ts`; that module imports
 * `ApproveChannelIngressRequestSchema` so wire validation and the published
 * spec cannot drift. Approve and revoke are POST verb paths rather than
 * PUT/DELETE on a grant path because the grant is not addressable on its
 * own — the source declares, and only a guardian decision creates anything
 * to name.
 *
 * Unlike the other channel APIs these are guardian-authenticated, not
 * scope-authenticated: approving ingress is the decision the assistant must
 * not be able to make for itself.
 */

/**
 * Request body for POST /v1/channel-ingress/{source}/approve.
 * `channel-ingress.ts` validates inbound bodies with this schema.
 */
export const ApproveChannelIngressRequestSchema = z.object({
  /**
   * Digest of the declaration being approved, as produced by
   * `ingressDeclarationDigest`. Must match what the source declares now, so
   * an approval is always a decision about routes the guardian has seen.
   */
  digest: z.string().regex(/^[0-9a-f]{32}$/),
});

const ApprovalViewSchema = z.object({
  source: z.string(),
  digest: z.string(),
  approvedAt: z.number(),
});

const IngressRouteViewSchema = z.object({
  path: z.string(),
  /** Absolute path the gateway would serve, which is the reach being granted. */
  publicPath: z.string(),
  kind: z.string(),
  signer: z.string(),
  handshake: z.string(),
  description: z.string(),
  /** Credential the route's signatures are verified against. */
  credential: z.string(),
  /**
   * Whether the gateway serves this route right now. Not implied by the
   * source's state: a `vellum`-signed route is served without approval.
   */
  served: z.boolean(),
  /**
   * Whether this route's replies deliver messages into the assistant, rather
   * than the route being a callback the plugin merely receives. Approving one
   * of these grants the plugin a way to start conversations, which is a
   * different decision than opening an address.
   */
  deliversInbound: z.boolean(),
  /** Present when the route declares its own verification scheme. */
  verification: z
    .object({ algorithm: z.string(), signatureHeader: z.string() })
    .optional(),
});

const IngressSourceViewSchema = z.object({
  source: z.string(),
  /** Approval state. Whether a given route is live is per-route `served`. */
  state: z.enum(["approved", "pending"]),
  /** Digest of what the source declares now: the one to approve. */
  digest: z.string(),
  approvedAt: z.number().optional(),
  /** On a pending source holding a grant for an earlier declaration. */
  approvedDigest: z.string().optional(),
  routes: z.array(IngressRouteViewSchema),
});

const ChannelIngressListSchema = z.object({
  sources: z.array(IngressSourceViewSchema),
  /** Declarations that failed validation. Unservable regardless of approval. */
  problems: z.array(z.object({ source: z.string(), reason: z.string() })),
});

export const ROUTES: GatewayRouteDefinition[] = [
  {
    path: "/v1/channel-ingress",
    method: "get",
    operationId: "channelIngressList",
    summary: "List ingress declarations and their approval state",
    description:
      "Every declaration the gateway can see, each with the digest a guardian would approve, the public paths it would open, and the credential its signatures are verified against. This is the only way to learn that a declaration is waiting: on the public surface a route held back by approval 404s exactly like one nobody declared.",
    tags: ["channel-ingress"],
    responseBody: ChannelIngressListSchema,
  },
  {
    path: "/v1/channel-ingress/{source}/approve",
    method: "post",
    operationId: "channelIngressApprove",
    summary: "Approve an ingress declaration",
    description:
      "Records the guardian's approval of the declaration identified by the body's digest, after which the gateway serves its routes. Returns 409 when the digest is not what the source currently declares, and 404 when it declares nothing servable.",
    tags: ["channel-ingress"],
    pathParameters: [
      {
        name: "source",
        description: "The declaring ingress source (today, a plugin name)",
      },
    ],
    requestBody: ApproveChannelIngressRequestSchema,
    responseBody: ApprovalViewSchema,
  },
  {
    path: "/v1/channel-ingress/{source}/revoke",
    method: "post",
    operationId: "channelIngressRevoke",
    summary: "Revoke an ingress approval",
    description:
      "Withdraws the source's grant, after which its routes stop being served. Reports whether there was a grant to withdraw. Succeeds even when the declaration itself has become unreadable.",
    tags: ["channel-ingress"],
    pathParameters: [
      {
        name: "source",
        description: "The declaring ingress source (today, a plugin name)",
      },
    ],
    responseBody: z.object({ source: z.string(), revoked: z.boolean() }),
  },
];
