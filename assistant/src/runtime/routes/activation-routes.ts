/**
 * Route handlers for the activation checklist.
 *
 * GET  /v1/activation/progress            : read the progress resource
 * POST /v1/activation/tasks/:taskId/start : link a task to a conversation
 * POST /v1/activation/dismiss             : record a dismissed surface
 *
 * Every route returns the full progress resource so a client never has to
 * follow a write with a read. The task catalog itself is client-side: the
 * daemon only stores opaque task and list identifiers.
 */

import type { z } from "zod";

import {
  dismissActivation,
  readActivationProgress,
  startActivationTask,
} from "../../activation/progress-store.js";
import {
  ActivationDismissRequestSchema,
  ActivationProgressSchema,
  ActivationTaskStartRequestSchema,
} from "../../api/responses/activation.js";
import { getConversation } from "../../persistence/conversation-crud.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { getOriginClientId } from "../sync/resource-sync-events.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

function parseBody<S extends z.ZodType>(
  schema: S,
  body: Record<string, unknown> | undefined,
): z.infer<S> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new BadRequestError(
      `Invalid activation request body: ${parsed.error.issues[0]?.message ?? "unknown field"}`,
    );
  }
  return parsed.data;
}

function handleGetActivationProgress() {
  return readActivationProgress();
}

/**
 * Link a task to the conversation its prompt is being sent to.
 *
 * The conversation is looked up the same way `POST /v1/messages` looks up an
 * explicit `conversationId`, and a miss is the same 404, because the two
 * calls are two halves of one launch: a link recorded against a row that no
 * longer exists leaves the task stuck on Working with an action that opens
 * nothing, while the send that follows fails anyway. Answering 404 instead
 * tells the client the link was refused outright, which is the one answer
 * that lets it take its freshly created conversation back.
 *
 * The store asks the same question again inside its lock, because the answer
 * can change while a contended mutation waits its turn: a deletion that
 * lands in that window has already run its own activation cleanup, so a link
 * written afterwards is the one nothing will ever clear. The check here is
 * the fast path that answers without taking a lock at all.
 */
async function handleStartActivationTask({
  pathParams = {},
  body,
  headers,
}: RouteHandlerArgs) {
  const { conversationId, listId } = parseBody(
    ActivationTaskStartRequestSchema,
    body,
  );
  const conversationExists = () => getConversation(conversationId) !== null;
  if (!conversationExists()) {
    throw new NotFoundError(`Conversation ${conversationId} not found`);
  }
  const originClientId = getOriginClientId(headers);
  return startActivationTask({
    taskId: pathParams.taskId ?? "",
    conversationId,
    verify: conversationExists,
    ...(listId !== undefined ? { listId } : {}),
    ...(originClientId !== undefined ? { originClientId } : {}),
  });
}

async function handleDismissActivation({ body, headers }: RouteHandlerArgs) {
  const { kind, listId } = parseBody(ActivationDismissRequestSchema, body);
  const originClientId = getOriginClientId(headers);
  return dismissActivation({
    kind,
    ...(listId !== undefined ? { listId } : {}),
    ...(originClientId !== undefined ? { originClientId } : {}),
  });
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "activation_progress_get",
    endpoint: "activation/progress",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get activation progress",
    description:
      "Return the activation checklist progress: the frozen list, dismissed surfaces, and per-task state.",
    tags: ["activation"],
    responseBody: ActivationProgressSchema,
    handler: handleGetActivationProgress,
  },
  {
    operationId: "activation_task_start_post",
    endpoint: "activation/tasks/:taskId/start",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Start an activation task",
    description:
      "Link an activation task to the conversation its prompt was sent to. Idempotent per task; a different conversation replaces the link only while the task is not done.",
    tags: ["activation"],
    pathParams: [
      { name: "taskId", description: "Catalog id of the launched task" },
    ],
    requestBody: ActivationTaskStartRequestSchema,
    responseBody: ActivationProgressSchema,
    handler: handleStartActivationTask,
    additionalResponses: {
      "400": { description: "Malformed task id, list id, or conversation id" },
      "404": { description: "No such conversation; the link was not recorded" },
      "409": {
        description:
          "Stored progress was written by a newer build; the link was not recorded",
      },
      "503": {
        description:
          "Stored progress is locked by another process; the link was not recorded",
      },
    },
  },
  {
    operationId: "activation_dismiss_post",
    endpoint: "activation/dismiss",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Dismiss an activation surface",
    description:
      "Record that the welcome modal or the celebration modal was dismissed.",
    tags: ["activation"],
    requestBody: ActivationDismissRequestSchema,
    responseBody: ActivationProgressSchema,
    handler: handleDismissActivation,
    additionalResponses: {
      "400": { description: "Malformed dismiss kind or list id" },
      "409": {
        description:
          "Stored progress was written by a newer build; the dismissal was not recorded",
      },
      "503": {
        description:
          "Stored progress is locked by another process; the dismissal was not recorded",
      },
    },
  },
];
