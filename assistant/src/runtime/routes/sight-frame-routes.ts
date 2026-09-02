/**
 * Transport-agnostic route definition for ambient camera keeps.
 *
 * POST /v1/conversations/:id/sight-frame persists one already-uploaded camera
 * frame into a conversation as its own sight-tagged user message. It runs no
 * turn and starts no agent loop: it is the same standalone-image persist the
 * live-voice `sight_frame` socket frame performs, reached over HTTP by the
 * clients that have a camera tile but no voice socket. The rationale for
 * persisting a kept frame on its own rather than attaching it to a turn is at
 * the top of `live-voice/live-voice-photo.ts`.
 *
 * The response is the client's per-frame acknowledgement, which is why the
 * handler waits on the persist rather than accepting and reporting later.
 */

import { z } from "zod";

import { persistAmbientSightFrame } from "../../live-voice/live-voice-photo.js";
import { getConversation } from "../../persistence/conversation-crud.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { resolveOrThrow } from "./conversation-management-routes.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";
import { resolveVellumActorTrustContext } from "./vellum-actor-trust.js";

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Persist a kept camera frame into an existing conversation.
 *
 * The DB existence check comes before the persist because the persist calls
 * `getOrCreateConversation`, which mints a conversation for an id it has never
 * seen. Without the gate a stale client id would silently create a phantom
 * conversation holding nothing but camera frames.
 *
 * That read is also where the frame is accepted, so the row's `created_at` is
 * taken from it and handed to the persist. Resolving the request's actor is
 * awaited below, and a conversation deleted and recreated under this id inside
 * that await leaves a row the gate never saw: the persist reading the id for
 * itself afterwards would take the replacement for the conversation the client
 * addressed. Nothing awaits between the check and the capture, so the two are
 * one moment.
 *
 * The body is hand-validated because the HTTP adapter does not run a route's
 * zod schema against the request and swallows a JSON parse failure, so a
 * malformed send arrives here as an empty bag.
 */
async function handleConversationSightFrame({
  pathParams = {},
  body = {},
  headers,
}: RouteHandlerArgs) {
  const rawId = pathParams.id!;
  const conversationId = resolveOrThrow(rawId);
  const accepted = getConversation(conversationId);
  if (!accepted) {
    throw new NotFoundError(`Conversation ${rawId} not found`);
  }

  const attachmentId = body.attachmentId;
  if (typeof attachmentId !== "string" || attachmentId.length === 0) {
    throw new BadRequestError("Missing attachmentId");
  }

  // The row is attributed to the actor this request was verified as, resolved
  // the way every other vellum-channel route resolves it. Left to the
  // conversation's resting trust, a frame would be stamped for whoever used
  // the conversation last.
  const trustContext = await resolveVellumActorTrustContext(
    headers?.["x-vellum-actor-principal-id"],
    { healResetDrift: true },
  );

  // Every non-fatal outcome the persist folds into `ok` is reported as a
  // refusal rather than an error status: the frame is gone either way, the
  // client's only move is to keep sampling, and the upload behind each one is
  // the persist's to settle. It gives the bytes up as it refuses, or, where
  // the store would not say whether a row landed, holds them until it answers
  // and gives them up then. Either way the client is done with the frame,
  // which is what the two-state response means.
  const result = await persistAmbientSightFrame(
    conversationId,
    attachmentId,
    "chat",
    trustContext,
    accepted.createdAt,
  );
  return {
    persisted: result.ok,
    ...(result.messageId === undefined ? {} : { messageId: result.messageId }),
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "conversationSightFrame",
    endpoint: "conversations/:id/sight-frame",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Persist an ambient camera frame",
    description:
      "Add an already-uploaded camera frame to a conversation as its own " +
      "message, tagged so retention can age the image out of the model's " +
      "context while the transcript keeps it. No reply is generated. " +
      "Returns persisted=false when the frame was dropped, in which case the " +
      "assistant owns the upload and there is nothing to clean up.",
    tags: ["conversations"],
    pathParams: [{ name: "id", type: "uuid" }],
    requestBody: z.object({
      attachmentId: z
        .string()
        .describe("Id of the uploaded attachment holding the frame."),
    }),
    responseBody: z.object({
      persisted: z.boolean(),
      messageId: z
        .string()
        .optional()
        .describe("The message the frame landed on, when one was written."),
    }),
    additionalResponses: {
      "400": { description: "Missing or empty attachmentId" },
      "404": { description: "Conversation not found" },
    },
    handler: handleConversationSightFrame,
  },
];
