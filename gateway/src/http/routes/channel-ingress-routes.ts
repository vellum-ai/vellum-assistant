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

export const ROUTES: GatewayRouteDefinition[] = [
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
