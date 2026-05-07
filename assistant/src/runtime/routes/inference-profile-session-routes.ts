/**
 * Route definitions for inference-profile session open/close/list operations.
 *
 * POST /v1/conversations/inference-profile-session       — open (or replace) a session
 * POST /v1/conversations/inference-profile-session/close — close an active session
 * GET  /v1/conversations/inference-profile-sessions      — list active sessions
 */

import { z } from "zod";

import { BadRequestError } from "./errors.js";
import {
  closeInferenceProfileSession,
  listInferenceProfileSessionsWithRemaining,
  setInferenceProfileSession,
} from "./inference-profile-session-handler.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleOpenInferenceProfileSession({
  body = {},
}: RouteHandlerArgs) {
  if (body.profile == null || typeof body.profile !== "string") {
    throw new BadRequestError("profile must be a non-empty string");
  }
  return setInferenceProfileSession({
    conversationId: body.conversationId as string,
    profile: body.profile,
    ttlSeconds: body.ttlSeconds as number | null | undefined,
    sessionId: body.sessionId as string | undefined,
  });
}

async function handleCloseInferenceProfileSession({
  body = {},
}: RouteHandlerArgs) {
  return closeInferenceProfileSession(body.conversationId as string);
}

function handleListInferenceProfileSessions({
  queryParams = {},
}: RouteHandlerArgs) {
  return {
    sessions: listInferenceProfileSessionsWithRemaining(
      queryParams.conversationId,
    ),
  };
}

// ---------------------------------------------------------------------------
// Transport-agnostic route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "inference_profile_open",
    endpoint: "conversations/inference-profile-session",
    method: "POST",
    policyKey: "conversations/inference-profile-session/open",
    summary: "Open an inference-profile session",
    description:
      "Open (or replace) a session-backed inference-profile override for a conversation. " +
      "Supports an optional TTL — omit for a sticky (non-expiring) override.",
    tags: ["conversations"],
    requestBody: z.object({
      conversationId: z.string().min(1),
      profile: z.string().min(1),
      ttlSeconds: z.number().positive().optional(),
      sessionId: z.string().uuid().optional(),
    }),
    responseBody: z.object({
      conversationId: z.string(),
      profile: z.string().nullable(),
      sessionId: z.string().nullable(),
      expiresAt: z.number().nullable(),
      ttlSeconds: z.number().nullable().optional(),
      replaced: z
        .object({
          profile: z.string().nullable(),
          sessionId: z.string().nullable(),
          expiresAt: z.number().nullable(),
        })
        .nullable(),
    }),
    handler: handleOpenInferenceProfileSession,
  },
  {
    operationId: "inference_profile_close",
    endpoint: "conversations/inference-profile-session/close",
    method: "POST",
    policyKey: "conversations/inference-profile-session/close",
    summary: "Close an inference-profile session",
    description:
      "Close the active session-backed inference-profile override for a conversation. " +
      "Only closes session-backed overrides; sticky overrides are left untouched.",
    tags: ["conversations"],
    requestBody: z.object({
      conversationId: z.string().min(1),
    }),
    responseBody: z.object({
      conversationId: z.string(),
      closed: z
        .object({
          profile: z.string().nullable(),
          sessionId: z.string().nullable(),
        })
        .nullable(),
      noop: z.boolean(),
    }),
    handler: handleCloseInferenceProfileSession,
  },
  {
    operationId: "inference_profile_list",
    endpoint: "conversations/inference-profile-sessions",
    method: "GET",
    policyKey: "conversations/inference-profile-sessions",
    summary: "List active inference-profile sessions",
    description:
      "List all active (non-expired) session-backed inference-profile overrides, " +
      "optionally filtered by conversationId.",
    tags: ["conversations"],
    queryParams: [
      {
        name: "conversationId",
        schema: { type: "string" },
        description: "Optional conversation ID filter",
      },
    ],
    responseBody: z.object({
      sessions: z.array(
        z.object({
          conversationId: z.string(),
          conversationTitle: z.string().nullable(),
          profile: z.string(),
          sessionId: z.string(),
          expiresAt: z.number(),
          remainingSeconds: z.number(),
        }),
      ),
    }),
    handler: handleListInferenceProfileSessions,
  },
];
