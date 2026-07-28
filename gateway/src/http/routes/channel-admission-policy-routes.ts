import { z } from "zod";
import { AdmissionPolicySchema } from "@vellumai/gateway-client";

import type { GatewayRouteDefinition } from "./types.js";

/**
 * OpenAPI route metadata for the per-channel admission-floor API.
 *
 * These schemas are the codegen source of truth for the generated gateway
 * SDK (see scripts/generate-openapi.ts). Clients consume the operations
 * through the SDK, which targets the assistant-scoped
 * `/v1/assistants/{assistant_id}/channel-admission-policy/...` routes
 * registered in `index.ts` alongside the flat paths documented here.
 * The policy enum comes from the shared contract in
 * `@vellumai/gateway-client` so gateway, clients, and spec share one source.
 *
 * The handlers live in `channel-admission-policy.ts`; that module imports
 * `SetChannelPolicyRequestSchema` so wire validation and the published spec
 * cannot drift. The gateway additionally accepts POST (PUT alias) and
 * DELETE (reset to seed default) on the per-channel path for legacy native
 * clients; only the canonical GET/PUT surface is published here.
 */

const ChannelPolicyViewSchema = z.object({
  channelType: z.string(),
  policy: AdmissionPolicySchema,
  note: z.string().nullable(),
  updatedAt: z.number().nullable(),
});

/**
 * Request body for PUT /v1/channel-admission-policy/{channel_type}.
 * `channel-admission-policy.ts` validates inbound bodies with this schema.
 */
export const SetChannelPolicyRequestSchema = z.object({
  policy: AdmissionPolicySchema,
  note: z.string().nullable().optional(),
});

export const ROUTES: GatewayRouteDefinition[] = [
  {
    path: "/v1/channel-admission-policy",
    method: "get",
    operationId: "channelAdmissionPolicyList",
    summary: "List per-channel admission floors",
    description:
      "Returns one entry per enforced channel (exempt and hidden channels are omitted), seeded with defaults for channels without a stored row.",
    tags: ["channel-admission-policy"],
    responseBody: z.object({
      policies: z.array(ChannelPolicyViewSchema),
    }),
  },
  {
    path: "/v1/channel-admission-policy/{channel_type}",
    method: "put",
    operationId: "channelAdmissionPolicySet",
    summary: "Set a channel's admission floor",
    description:
      "Upserts the channel's admission policy. Exempt and hidden channels return 403.",
    tags: ["channel-admission-policy"],
    pathParameters: [
      { name: "channel_type", description: "The channel type (e.g. slack)" },
    ],
    requestBody: SetChannelPolicyRequestSchema,
    responseBody: z.object({ policy: ChannelPolicyViewSchema }),
  },
];
