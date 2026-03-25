/**
 * Runtime HTTP route handlers for the call API.
 *
 * POST   /v1/calls/start              — initiate a new call
 * GET    /v1/calls/:callSessionId      — get call status
 * POST   /v1/calls/:callSessionId/cancel — cancel a call
 * POST   /v1/calls/:callSessionId/answer — answer a pending question
 * POST   /v1/calls/:callSessionId/instruction — relay an instruction to an active call
 */

import {
  answerCall,
  cancelCall,
  getCallStatus,
  relayInstruction,
  startCall,
} from "../../calls/call-domain.js";
import { getConfig } from "../../config/loader.js";
import { VALID_CALLER_IDENTITY_MODES } from "../../config/schema.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { httpError, httpErrorCodeFromStatus } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

// ── Idempotency cache ─────────────────────────────────────────────────────────
// Stores serialized 201 responses keyed by idempotencyKey for 5 minutes so
// that network-retry duplicates from the client don't start a second call.

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface IdempotencyEntry {
  body: unknown;
  expiresAt: number;
}

const idempotencyCache = new Map<string, IdempotencyEntry>();

function pruneIdempotencyCache(): void {
  const now = Date.now();
  for (const [key, entry] of idempotencyCache) {
    if (entry.expiresAt <= now) idempotencyCache.delete(key);
  }
}

/**
 * POST /v1/calls/start
 *
 * Body: { phoneNumber: string; task: string; context?: string; conversationId: string; callerIdentityMode?: 'assistant_number' | 'user_number'; idempotencyKey?: string }
 *
 * Optional `idempotencyKey`: if supplied, duplicate requests with the same key
 * within 5 minutes return the cached 201 response without starting a second call.
 */
export async function handleStartCall(
  req: Request,
  assistantId: string = DAEMON_INTERNAL_ASSISTANT_ID,
): Promise<Response> {
  if (!getConfig().calls.enabled) {
    return httpError(
      "FORBIDDEN",
      "Calls feature is disabled via configuration. Set calls.enabled to true to use this feature.",
      403,
    );
  }

  let body: {
    phoneNumber?: string;
    task?: string;
    context?: string;
    conversationId?: string;
    callerIdentityMode?: "assistant_number" | "user_number";
    idempotencyKey?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return httpError("BAD_REQUEST", "Invalid JSON in request body", 400);
  }

  if (typeof body !== "object" || body == null || Array.isArray(body)) {
    return httpError("BAD_REQUEST", "Request body must be a JSON object", 400);
  }

  if (!body.conversationId) {
    return httpError("BAD_REQUEST", "conversationId is required", 400);
  }

  if (
    body.callerIdentityMode != null &&
    !(VALID_CALLER_IDENTITY_MODES as readonly string[]).includes(
      body.callerIdentityMode as string,
    )
  ) {
    return httpError(
      "BAD_REQUEST",
      `Invalid callerIdentityMode: "${
        body.callerIdentityMode
      }". Must be one of: ${VALID_CALLER_IDENTITY_MODES.join(", ")}`,
      400,
    );
  }

  // Idempotency check: return cached response for duplicate requests
  const idempotencyKey =
    typeof body.idempotencyKey === "string" && body.idempotencyKey
      ? body.idempotencyKey
      : null;

  if (idempotencyKey) {
    pruneIdempotencyCache();
    const cached = idempotencyCache.get(idempotencyKey);
    if (cached && cached.expiresAt > Date.now()) {
      return Response.json(cached.body, { status: 201 });
    }
  }

  const result = await startCall({
    phoneNumber: body.phoneNumber ?? "",
    task: body.task ?? "",
    context: body.context,
    conversationId: body.conversationId,
    assistantId,
    callerIdentityMode: body.callerIdentityMode,
  });

  if (!result.ok) {
    const status = result.status ?? 500;
    return httpError(httpErrorCodeFromStatus(status), result.error, status);
  }

  const responseBody = {
    callSessionId: result.session.id,
    callSid: result.callSid,
    status: result.session.status,
    toNumber: result.session.toNumber,
    fromNumber: result.session.fromNumber,
    callerIdentityMode: result.callerIdentityMode,
  };

  if (idempotencyKey) {
    idempotencyCache.set(idempotencyKey, {
      body: responseBody,
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
    });
  }

  return Response.json(responseBody, { status: 201 });
}

/**
 * GET /v1/calls/:callSessionId
 */
function handleGetCallStatus(callSessionId: string): Response {
  const result = getCallStatus(callSessionId);

  if (!result.ok) {
    const status = result.status ?? 500;
    return httpError(httpErrorCodeFromStatus(status), result.error, status);
  }

  const { session } = result;
  return Response.json({
    callSessionId: session.id,
    conversationId: session.conversationId,
    status: session.status,
    toNumber: session.toNumber,
    fromNumber: session.fromNumber,
    provider: session.provider,
    providerCallSid: session.providerCallSid,
    task: session.task,
    startedAt: session.startedAt
      ? new Date(session.startedAt).toISOString()
      : null,
    endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : null,
    lastError: session.lastError,
    pendingQuestion: result.pendingQuestion ?? null,
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
  });
}

/**
 * POST /v1/calls/:callSessionId/cancel
 *
 * Body: { reason?: string }
 */
export async function handleCancelCall(
  req: Request,
  callSessionId: string,
): Promise<Response> {
  let reason: string | undefined;
  try {
    const body = (await req.json()) as { reason?: string };
    reason = body.reason;
  } catch {
    // Empty body is fine
  }

  const result = await cancelCall({ callSessionId, reason });

  if (!result.ok) {
    const status = result.status ?? 500;
    return httpError(httpErrorCodeFromStatus(status), result.error, status);
  }

  return Response.json({
    callSessionId: result.session.id,
    status: result.session.status,
  });
}

/**
 * POST /v1/calls/:callSessionId/answer
 *
 * Body: { answer: string }
 */
export async function handleAnswerCall(
  req: Request,
  callSessionId: string,
): Promise<Response> {
  let body: { answer?: string; pendingQuestionId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return httpError("BAD_REQUEST", "Invalid JSON in request body", 400);
  }

  if (typeof body !== "object" || body == null || Array.isArray(body)) {
    return httpError("BAD_REQUEST", "Request body must be a JSON object", 400);
  }

  const result = await answerCall({
    callSessionId,
    answer: body.answer ?? "",
    pendingQuestionId:
      typeof body.pendingQuestionId === "string"
        ? body.pendingQuestionId
        : undefined,
  });

  if (!result.ok) {
    const status = result.status ?? 500;
    return httpError(httpErrorCodeFromStatus(status), result.error, status);
  }

  return Response.json({ ok: true, questionId: result.questionId });
}

/**
 * POST /v1/calls/:callSessionId/instruction
 *
 * Body: { instruction: string }
 */
export async function handleInstructionCall(
  req: Request,
  callSessionId: string,
): Promise<Response> {
  let body: { instruction?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return httpError("BAD_REQUEST", "Invalid JSON in request body", 400);
  }

  if (typeof body !== "object" || body == null || Array.isArray(body)) {
    return httpError("BAD_REQUEST", "Request body must be a JSON object", 400);
  }

  const result = await relayInstruction({
    callSessionId,
    instructionText: body.instruction ?? "",
  });

  if (!result.ok) {
    const status = result.status ?? 500;
    return httpError(httpErrorCodeFromStatus(status), result.error, status);
  }

  return Response.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function callRouteDefinitions(deps: {
  assistantId: string;
}): RouteDefinition[] {
  return [
    {
      endpoint: "calls/start",
      method: "POST",
      summary: "Start a call",
      description:
        "Initiate a new outbound phone call. Supports idempotency keys to prevent duplicate calls.",
      tags: ["calls"],
      handler: async ({ req }) => handleStartCall(req, deps.assistantId),
      requestBody: {
        type: "object",
        properties: {
          phoneNumber: { type: "string", description: "Phone number to call" },
          task: {
            type: "string",
            description: "Task description for the call",
          },
          context: {
            type: "string",
            description: "Additional context for the call",
          },
          conversationId: {
            type: "string",
            description: "Conversation to associate with",
          },
          callerIdentityMode: {
            type: "string",
            description: "Caller identity: 'assistant_number' or 'user_number'",
          },
          idempotencyKey: {
            type: "string",
            description: "Idempotency key to prevent duplicate calls",
          },
        },
        required: ["conversationId"],
      },
      responseBody: {
        type: "object",
        properties: {
          callSessionId: { type: "string" },
          callSid: { type: "string" },
          status: { type: "string" },
          toNumber: { type: "string" },
          fromNumber: { type: "string" },
          callerIdentityMode: { type: "string" },
        },
      },
    },
    {
      endpoint: "calls/:id/cancel",
      method: "POST",
      policyKey: "calls/cancel",
      summary: "Cancel a call",
      description: "Cancel an active or pending call.",
      tags: ["calls"],
      handler: async ({ req, params }) => handleCancelCall(req, params.id),
      requestBody: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Cancellation reason" },
        },
      },
      responseBody: {
        type: "object",
        properties: {
          callSessionId: { type: "string" },
          status: { type: "string" },
        },
      },
    },
    {
      endpoint: "calls/:id/answer",
      method: "POST",
      policyKey: "calls/answer",
      summary: "Answer a pending call question",
      description:
        "Provide an answer to a pending question during an active call.",
      tags: ["calls"],
      handler: async ({ req, params }) => handleAnswerCall(req, params.id),
      requestBody: {
        type: "object",
        properties: {
          answer: { type: "string", description: "Answer text" },
          pendingQuestionId: {
            type: "string",
            description: "ID of the pending question",
          },
        },
      },
      responseBody: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          questionId: { type: "string" },
        },
      },
    },
    {
      endpoint: "calls/:id/instruction",
      method: "POST",
      policyKey: "calls/instruction",
      summary: "Relay instruction to active call",
      description: "Send a real-time instruction to an active call.",
      tags: ["calls"],
      handler: async ({ req, params }) => handleInstructionCall(req, params.id),
      requestBody: {
        type: "object",
        properties: {
          instruction: {
            type: "string",
            description: "Instruction text to relay",
          },
        },
      },
      responseBody: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
        },
      },
    },
    {
      endpoint: "calls/:id",
      method: "GET",
      policyKey: "calls",
      summary: "Get call status",
      description: "Return the current status and details of a call session.",
      tags: ["calls"],
      handler: ({ params }) => handleGetCallStatus(params.id),
      responseBody: {
        type: "object",
        properties: {
          callSessionId: { type: "string" },
          conversationId: { type: "string" },
          status: { type: "string" },
          toNumber: { type: "string" },
          fromNumber: { type: "string" },
          provider: { type: "string" },
          providerCallSid: { type: "string" },
          task: { type: "string" },
          startedAt: { type: "string" },
          endedAt: { type: "string" },
          lastError: { type: "string" },
          pendingQuestion: { type: "object" },
          createdAt: { type: "string" },
          updatedAt: { type: "string" },
        },
      },
    },
  ];
}
