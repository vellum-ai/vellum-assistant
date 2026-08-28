import { RiskThresholdSchema } from "@vellumai/gateway-client";
import { z } from "zod";

import type { GatewayRouteDefinition } from "./types.js";

/**
 * OpenAPI route metadata for the gateway-native contacts control plane.
 *
 * These schemas are the codegen source of truth for the operations that
 * exist ONLY on the gateway (they have no daemon HTTP counterpart, so they
 * are absent from the daemon SDK): contact upsert, contact delete,
 * contact-prompt submit, contact-record submit, and manual channel verify. Clients consume them
 * through the generated gateway SDK, which emits assistant-scoped
 * `/v1/assistants/{assistant_id}/...` URLs — but both deployment boundaries
 * strip the scope before the gateway routes the request (Django's
 * RuntimeProxyView in cloud; `rewriteForSelfHostedIngress` contact-family
 * flattening in self-hosted), so the gateway serves exactly the flat paths
 * in this spec.
 *
 * The handlers live in `contacts-control-plane-proxy.ts` (upsert, delete,
 * verify) and `contact-prompt.ts` (prompt and record submit); this module is
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
  autoApproveThreshold: RiskThresholdSchema.nullable().describe(
    "Per-contact auto-approve ceiling. Null means unset (inherit cascade).",
  ),
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
  autoApproveThreshold: RiskThresholdSchema.nullable()
    .optional()
    .describe(
      "Per-contact auto-approve ceiling. Omit to preserve; null clears.",
    ),
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
    .describe("The contact_request id broadcast by the assistant"),
  address: z.string().optional().describe("Required unless cancelled is true"),
  channelType: z
    .string()
    .optional()
    .describe("Required unless cancelled is true"),
  role: z.string().optional(),
  displayName: z.string().optional(),
  verify: z
    .boolean()
    .optional()
    .describe(
      "The form's 'mark verified' checkbox as the guardian left it. Omit only from clients that predate the checkbox; the parked command's flag is then used instead.",
    ),
  cancelled: z
    .boolean()
    .optional()
    .describe(
      "The guardian dismissed the form. Unblocks the waiting command without writing.",
    ),
});

const ContactRecordSubmitRequestSchema = z.object({
  requestId: z
    .string()
    .describe("The contact_record_request id broadcast by the assistant"),
  operation: z
    .enum(["create", "update", "delete"])
    .optional()
    .describe("Required unless cancelled is true"),
  contactId: z.string().optional().describe("Required to update or delete"),
  displayName: z.string().optional(),
  notes: z.string().nullable().optional(),
  expectedChannels: z
    .array(z.object({ type: z.string(), address: z.string() }))
    .optional()
    .describe(
      "The channels the delete confirmation listed. The delete is refused if the contact's channels changed since.",
    ),
  cancelled: z
    .boolean()
    .optional()
    .describe(
      "The guardian dismissed the form. Unblocks the waiting command without writing.",
    ),
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
      "Completes a contact_request the assistant broadcast: writes the contact and channel gateway-first, then unblocks the waiting prompt.",
    tags: ["contacts"],
    requestBody: ContactPromptSubmitRequestSchema,
    responseBody: z.object({
      accepted: z.boolean(),
      error: z.string().optional(),
      duplicate: z
        .boolean()
        .optional()
        .describe(
          "Another client answered this form first. Nothing is wrong, but none of this submission's values were written.",
        ),
    }),
  },
  {
    path: "/v1/contacts/record/submit",
    method: "post",
    operationId: "contactsRecordSubmit",
    summary: "Submit a contact-record form",
    description:
      "Completes a contact_record_request the assistant broadcast: writes the contact record the guardian confirmed (display name and notes only, never a channel), then unblocks the waiting command. A cancelled submission unblocks it without writing.",
    tags: ["contacts"],
    requestBody: ContactRecordSubmitRequestSchema,
    responseBody: z.object({
      accepted: z.boolean(),
      error: z.string().optional(),
      duplicate: z
        .boolean()
        .optional()
        .describe(
          "Another client answered this form first. Nothing is wrong, but none of this submission's values were written.",
        ),
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
