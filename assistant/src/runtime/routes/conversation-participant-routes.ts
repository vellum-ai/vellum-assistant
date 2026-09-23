/**
 * Guardian routes for the principals a conversation is shared with.
 *
 * GET    /v1/conversations/:id/participants
 * POST   /v1/conversations/:id/participants
 * DELETE /v1/conversations/:id/participants/:principalId
 *
 * A principal may be added only while it holds an active contact on the
 * `vellum-shared` channel, read fresh from the gateway so a just-revoked
 * contact is refused.
 */

import { z } from "zod";

import { conversationMetadataSyncTag } from "../../daemon/message-types/sync.js";
import {
  addParticipant,
  type ConversationParticipant,
  listParticipants,
  removeParticipant,
} from "../../persistence/conversation-participants.js";
import { ACTOR_PRINCIPALS, GUARDIAN_ONLY } from "../auth/route-policy.js";
import { resolveSharedPrincipalFresh } from "../shared-principal-lookup.js";
import { getOriginClientId } from "../sync/resource-sync-events.js";
import { publishSyncInvalidation } from "../sync/sync-publisher.js";
import { resolveOrThrow } from "./conversation-management-routes.js";
import {
  BadRequestError,
  NotFoundError,
  UnprocessableEntityError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const participantSchema = z.object({
  principalId: z.string(),
  role: z.enum(["creator", "participant"]),
  addedBy: z.string().nullable(),
  addedAt: z.number(),
});

const AddParticipantBody = z.object({
  principalId: z.string().trim().min(1),
});

function serialize(participant: ConversationParticipant) {
  return {
    principalId: participant.principalId,
    role: participant.role,
    addedBy: participant.addedBy,
    addedAt: participant.addedAt,
  };
}

function publishParticipantsChanged(
  conversationId: string,
  headers: RouteHandlerArgs["headers"],
): void {
  void publishSyncInvalidation(
    [conversationMetadataSyncTag(conversationId)],
    getOriginClientId(headers),
  );
}

function handleListParticipants({ pathParams = {} }: RouteHandlerArgs) {
  const conversationId = resolveOrThrow(pathParams.id!);
  return { participants: listParticipants(conversationId).map(serialize) };
}

async function handleAddParticipant({
  pathParams = {},
  body,
  headers,
}: RouteHandlerArgs) {
  const parsed = AddParticipantBody.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError("principalId is required");
  }
  const conversationId = resolveOrThrow(pathParams.id!);
  const { principalId } = parsed.data;

  const { trustClass } = await resolveSharedPrincipalFresh(principalId);
  if (trustClass !== "trusted_contact") {
    throw new UnprocessableEntityError(
      `Principal ${principalId} is not an active contact`,
    );
  }

  const participant = addParticipant({
    conversationId,
    principalId,
    role: "participant",
    addedBy: headers?.["x-vellum-actor-principal-id"]?.trim() || null,
  });
  publishParticipantsChanged(conversationId, headers);
  return { participant: serialize(participant) };
}

function handleRemoveParticipant({
  pathParams = {},
  headers,
}: RouteHandlerArgs) {
  const conversationId = resolveOrThrow(pathParams.id!);
  const principalId = pathParams.principalId!;
  if (!removeParticipant(conversationId, principalId)) {
    throw new NotFoundError(
      `Principal ${principalId} is not a participant of conversation ${conversationId}`,
    );
  }
  publishParticipantsChanged(conversationId, headers);
}

const conversationIdParam = { name: "id", type: "uuid" } as const;

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listConversationParticipants",
    endpoint: "conversations/:id/participants",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
      allowedTrustClasses: GUARDIAN_ONLY,
    },
    summary: "List conversation participants",
    description:
      "List the principals a conversation is currently shared with, earliest added first.",
    tags: ["conversations"],
    pathParams: [conversationIdParam],
    responseBody: z.object({ participants: z.array(participantSchema) }),
    additionalResponses: {
      "404": { description: "Conversation not found" },
    },
    handler: handleListParticipants,
  },
  {
    operationId: "addConversationParticipant",
    endpoint: "conversations/:id/participants",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
      allowedTrustClasses: GUARDIAN_ONLY,
    },
    summary: "Share a conversation with a contact",
    description:
      "Add a principal holding an active shared-conversation contact to a conversation. " +
      "Adding a principal who is already a participant leaves their entry unchanged.",
    tags: ["conversations"],
    pathParams: [conversationIdParam],
    requestBody: AddParticipantBody,
    responseBody: z.object({ participant: participantSchema }),
    additionalResponses: {
      "404": { description: "Conversation not found" },
      "422": { description: "Principal is not an active contact" },
    },
    handler: handleAddParticipant,
  },
  {
    operationId: "removeConversationParticipant",
    endpoint: "conversations/:id/participants/:principalId",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
      allowedTrustClasses: GUARDIAN_ONLY,
    },
    summary: "Stop sharing a conversation with a participant",
    description:
      "Remove a principal from a conversation. The record of their participation is kept.",
    tags: ["conversations"],
    pathParams: [conversationIdParam, { name: "principalId" }],
    responseStatus: "204",
    additionalResponses: {
      "404": { description: "Conversation or participant not found" },
    },
    handler: handleRemoveParticipant,
  },
];
