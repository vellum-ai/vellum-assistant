import { z } from "zod";

import type { GatewayRouteDefinition } from "./types.js";

/**
 * OpenAPI route metadata for the gateway-native contacts control plane.
 *
 * These schemas are the codegen source of truth for the operations that
 * exist ONLY on the gateway (they have no daemon HTTP counterpart, so they
 * are absent from the daemon SDK): contact upsert, contact delete,
 * contact-prompt submit, and manual channel verify. Clients consume them
 * through the generated gateway SDK, which emits assistant-scoped
 * `/v1/assistants/{assistant_id}/...` URLs — but both deployment boundaries
 * strip the scope before the gateway routes the request (Django's
 * RuntimeProxyView in cloud; `rewriteForSelfHostedIngress` contact-family
 * flattening in self-hosted), so the gateway serves exactly the flat paths
 * in this spec.
 *
 * The handlers live in `contacts-control-plane-proxy.ts` (upsert, delete,
 * verify) and `contact-prompt.ts` (prompt submit); this module is
 * intentionally schema-only so `scripts/generate-openapi.ts` can import it
 * without pulling in DB or IPC dependencies.
 */

// ---------------------------------------------------------------------------
// Wire shapes (matching toContactPayload / ContactStore rows)
// ---------------------------------------------------------------------------

const ContactChannelPayloadSchema = z.object({
  id: z.string(),
  contactId: z.string(),
  type: z.string(),
  address: z.string(),
  isPrimary: z.boolean(),
  externalChatId: z.string().nullable(),
  externalUserId: z
    .string()
    .describe("Compat alias for address (older macOS clients)"),
  status: z.string().nullable(),
  policy: z.string().nullable(),
  verifiedAt: z.number().nullable(),
  verifiedVia: z.string().nullable(),
  inviteId: z.string().nullable(),
  revokedReason: z.string().nullable(),
  blockedReason: z.string().nullable(),
  lastSeenAt: z.number().nullable(),
  interactionCount: z.number(),
  lastInteraction: z.number().nullable(),
  createdAt: z.number().nullable(),
  updatedAt: z.number().nullable(),
});

const AssistantContactMetadataSchema = z.object({
  species: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

const ContactPayloadSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  role: z.string(),
  notes: z.string().nullable(),
  contactType: z.string().nullable(),
  principalId: z.string().nullable(),
  userFile: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  interactionCount: z.number(),
  lastInteraction: z.number().nullable(),
  assistantMetadata: AssistantContactMetadataSchema.nullable(),
  channels: z.array(ContactChannelPayloadSchema),
});

/** Gateway contact_channels row (no compat alias), returned by verify. */
const ContactChannelRowSchema = ContactChannelPayloadSchema.omit({
  externalUserId: true,
});

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

const UpsertContactChannelInputSchema = z.object({
  type: z.string(),
  address: z.string(),
  isPrimary: z.boolean().optional(),
  externalChatId: z.string().nullable().optional(),
  status: z.string().optional(),
  policy: z.string().optional(),
});

const UpsertContactRequestSchema = z.object({
  id: z
    .string()
    .optional()
    .describe(
      "Existing contact id to update; omit to create or match by channel",
    ),
  displayName: z
    .string()
    .min(1)
    .describe("Required on every upsert, including updates by id"),
  notes: z.string().nullable().optional(),
  contactType: z.string().optional(),
  assistantMetadata: z
    .object({
      species: z.string(),
      metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .optional()
    .describe("Required when contactType is 'assistant'"),
  channels: z.array(UpsertContactChannelInputSchema).optional(),
});

const ContactPromptSubmitRequestSchema = z.object({
  requestId: z
    .string()
    .describe("The contact_request id broadcast by the daemon"),
  address: z.string(),
  channelType: z.string(),
  role: z.string().optional(),
  displayName: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Route definitions (consumed by scripts/generate-openapi.ts)
// ---------------------------------------------------------------------------

export const ROUTES: GatewayRouteDefinition[] = [
  {
    path: "/v1/contacts",
    method: "post",
    operationId: "contactsUpsert",
    summary: "Create or update a contact",
    description:
      "Gateway-native contact upsert (dual-writes the gateway ACL store and the assistant info mirror). Matches by id, then by any provided (type, address) channel, else creates.",
    tags: ["contacts"],
    requestBody: UpsertContactRequestSchema,
    responseBody: z.object({
      ok: z.boolean(),
      contact: ContactPayloadSchema,
    }),
  },
  {
    path: "/v1/contacts/{contact_id}",
    method: "delete",
    operationId: "contactDelete",
    summary: "Delete a contact",
    description:
      "Deletes a non-guardian contact from the gateway ACL store and the assistant mirror. 404 when the contact exists in neither; 403 for guardian contacts.",
    tags: ["contacts"],
    pathParameters: [{ name: "contact_id", description: "The contact id" }],
    responseStatus: "204",
  },
  {
    path: "/v1/contacts/prompt/submit",
    method: "post",
    operationId: "contactsPromptSubmit",
    summary: "Submit a contact-prompt address",
    description:
      "Completes a daemon-broadcast contact_request: writes the contact and channel gateway-first, then unblocks the waiting prompt via daemon IPC.",
    tags: ["contacts"],
    requestBody: ContactPromptSubmitRequestSchema,
    responseBody: z.object({
      accepted: z.boolean(),
      error: z.string().optional(),
    }),
  },
  {
    path: "/v1/contact-channels/{channel_id}/verify",
    method: "post",
    operationId: "contactChannelVerify",
    summary: "Manually verify a contact channel",
    description:
      "Guardian-only manual attestation: marks the channel active/verified in the gateway store (source of truth) with a best-effort assistant mirror. Idempotent.",
    tags: ["contacts"],
    pathParameters: [
      { name: "channel_id", description: "The contact-channel id" },
    ],
    responseBody: z.object({
      ok: z.boolean(),
      channel: ContactChannelRowSchema,
    }),
  },
];
