/**
 * Transport-agnostic route definitions for the call API.
 *
 * POST   /v1/calls/start                       — initiate a new call
 * GET    /v1/calls/:callSessionId               — get call status
 * POST   /v1/calls/:callSessionId/cancel        — cancel a call
 * POST   /v1/calls/:callSessionId/answer        — answer a pending question
 * POST   /v1/calls/:callSessionId/instruction   — relay an instruction to an active call
 */

import { z } from "zod";

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
import { BadRequestError, ForbiddenError, RouteError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Idempotency cache ─────────────────────────────────────────────────────────
// Stores serialized 201 responses keyed by idempotencyKey for 5 minutes so
// that network-retry duplicates from the client don't start a second call.

const CALL_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes

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

// ── Error helper ──────────────────────────────────────────────────────────────

const STATUS_CODE_MAP: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: "UNPROCESSABLE_ENTITY",
  424: "FAILED_DEPENDENCY",
  429: "RATE_LIMITED",
  503: "SERVICE_UNAVAILABLE",
};

function throwDomainError(error: string, status: number): never {
  throw new RouteError(error, STATUS_CODE_MAP[status] ?? "INTERNAL_ERROR", status);
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleStartCall({ body }: RouteHandlerArgs) {
  if (!getConfig().calls.enabled) {
    throw new ForbiddenError(
      "Calls feature is disabled via configuration. Set calls.enabled to true to use this feature.",
    );
  }

  if (!body?.conversationId) {
    throw new BadRequestError("conversationId is required");
  }

  if (
    body.callerIdentityMode != null &&
    !(VALID_CALLER_IDENTITY_MODES as readonly string[]).includes(
      body.callerIdentityMode as string,
    )
  ) {
    throw new BadRequestError(
      `Invalid callerIdentityMode: "${
        body.callerIdentityMode
      }". Must be one of: ${VALID_CALLER_IDENTITY_MODES.join(", ")}`,
    );
  }

  const idempotencyKey =
    typeof body.idempotencyKey === "string" && body.idempotencyKey
      ? (body.idempotencyKey as string)
      : null;

  if (idempotencyKey) {
    pruneIdempotencyCache();
    const cached = idempotencyCache.get(idempotencyKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.body;
    }
  }

  const result = await startCall({
    phoneNumber: (body.phoneNumber as string) ?? "",
    task: (body.task as string) ?? "",
    context: body.context as string | undefined,
    conversationId: body.conversationId as string,
    assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
    callerIdentityMode: body.callerIdentityMode as
      | "assistant_number"
      | "user_number"
      | undefined,
  });

  if (!result.ok) {
    throwDomainError(result.error, result.status ?? 500);
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
      expiresAt: Date.now() + CALL_IDEMPOTENCY_TTL_MS,
    });
  }

  return responseBody;
}

function handleGetCallStatus({ pathParams }: RouteHandlerArgs) {
  const callSessionId = pathParams?.callSessionId;
  if (!callSessionId) {
    throw new BadRequestError("callSessionId is required");
  }

  const result = getCallStatus(callSessionId);

  if (!result.ok) {
    throwDomainError(result.error, result.status ?? 500);
  }

  const { session } = result;
  return {
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
  };
}

async function handleCancelCall({ pathParams, body }: RouteHandlerArgs) {
  const callSessionId = pathParams?.callSessionId;
  if (!callSessionId) {
    throw new BadRequestError("callSessionId is required");
  }

  const result = await cancelCall({
    callSessionId,
    reason: body?.reason as string | undefined,
  });

  if (!result.ok) {
    throwDomainError(result.error, result.status ?? 500);
  }

  return {
    callSessionId: result.session.id,
    status: result.session.status,
  };
}

async function handleAnswerCall({ pathParams, body }: RouteHandlerArgs) {
  const callSessionId = pathParams?.callSessionId;
  if (!callSessionId) {
    throw new BadRequestError("callSessionId is required");
  }

  const result = await answerCall({
    callSessionId,
    answer: (body?.answer as string) ?? "",
    pendingQuestionId:
      typeof body?.pendingQuestionId === "string"
        ? body.pendingQuestionId
        : undefined,
  });

  if (!result.ok) {
    throwDomainError(result.error, result.status ?? 500);
  }

  return { ok: true, questionId: result.questionId };
}

async function handleInstructionCall({ pathParams, body }: RouteHandlerArgs) {
  const callSessionId = pathParams?.callSessionId;
  if (!callSessionId) {
    throw new BadRequestError("callSessionId is required");
  }

  const result = await relayInstruction({
    callSessionId,
    instructionText: (body?.instruction as string) ?? "",
  });

  if (!result.ok) {
    throwDomainError(result.error, result.status ?? 500);
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "calls_start",
    endpoint: "calls/start",
    method: "POST",
    policyKey: "calls/start",
    requirePolicyEnforcement: true,
    summary: "Start a call",
    description:
      "Initiate a new outbound phone call. Supports idempotency keys to prevent duplicate calls.",
    tags: ["calls"],
    responseStatus: "201",
    requestBody: z.object({
      phoneNumber: z.string().describe("Phone number to call").optional(),
      task: z.string().describe("Task description for the call").optional(),
      context: z
        .string()
        .describe("Additional context for the call")
        .optional(),
      conversationId: z.string().describe("Conversation to associate with"),
      callerIdentityMode: z
        .string()
        .describe("Caller identity: 'assistant_number' or 'user_number'")
        .optional(),
      idempotencyKey: z
        .string()
        .describe("Idempotency key to prevent duplicate calls")
        .optional(),
    }),
    responseBody: z.object({
      callSessionId: z.string(),
      callSid: z.string(),
      status: z.string(),
      toNumber: z.string(),
      fromNumber: z.string(),
      callerIdentityMode: z.string(),
    }),
    handler: handleStartCall,
  },
  {
    operationId: "calls_cancel",
    endpoint: "calls/:callSessionId/cancel",
    method: "POST",
    policyKey: "calls/cancel",
    requirePolicyEnforcement: true,
    summary: "Cancel a call",
    description: "Cancel an active or pending call.",
    tags: ["calls"],
    requestBody: z.object({
      reason: z.string().describe("Cancellation reason").optional(),
    }),
    responseBody: z.object({
      callSessionId: z.string(),
      status: z.string(),
    }),
    handler: handleCancelCall,
  },
  {
    operationId: "calls_answer",
    endpoint: "calls/:callSessionId/answer",
    method: "POST",
    policyKey: "calls/answer",
    requirePolicyEnforcement: true,
    summary: "Answer a pending call question",
    description:
      "Provide an answer to a pending question during an active call.",
    tags: ["calls"],
    requestBody: z.object({
      answer: z.string().describe("Answer text"),
      pendingQuestionId: z
        .string()
        .describe("ID of the pending question")
        .optional(),
    }),
    responseBody: z.object({
      ok: z.boolean(),
      questionId: z.string(),
    }),
    handler: handleAnswerCall,
  },
  {
    operationId: "calls_instruction",
    endpoint: "calls/:callSessionId/instruction",
    method: "POST",
    policyKey: "calls/instruction",
    requirePolicyEnforcement: true,
    summary: "Relay instruction to active call",
    description: "Send a real-time instruction to an active call.",
    tags: ["calls"],
    requestBody: z.object({
      instruction: z.string().describe("Instruction text to relay"),
    }),
    responseBody: z.object({
      ok: z.boolean(),
    }),
    handler: handleInstructionCall,
  },
  {
    operationId: "calls_get",
    endpoint: "calls/:callSessionId",
    method: "GET",
    policyKey: "calls",
    requirePolicyEnforcement: true,
    summary: "Get call status",
    description: "Return the current status and details of a call session.",
    tags: ["calls"],
    responseBody: z.object({
      callSessionId: z.string(),
      conversationId: z.string(),
      status: z.string(),
      toNumber: z.string(),
      fromNumber: z.string(),
      provider: z.string(),
      providerCallSid: z.string(),
      task: z.string(),
      startedAt: z.string().nullable(),
      endedAt: z.string().nullable(),
      lastError: z.string().nullable(),
      pendingQuestion: z.object({}).passthrough().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
    handler: handleGetCallStatus,
  },
];
