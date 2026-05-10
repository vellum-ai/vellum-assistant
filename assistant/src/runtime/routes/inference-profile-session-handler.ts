/**
 * Shared business-logic handler for inference-profile session open/close/list.
 *
 * This module is the single source of truth for:
 *  - setInferenceProfileSession  — open (or replace) a session-backed profile
 *  - closeInferenceProfileSession — close the active session
 *  - listInferenceProfileSessionsWithRemaining — list active sessions with
 *    remaining TTL
 *
 * Route handlers in `inference-profile-session-routes.ts` (PR 4) and the IPC
 * route equivalents delegate to these functions rather than duplicating the
 * logic.
 */

import { randomUUID } from "node:crypto";

import { loadConfig } from "../../config/loader.js";
import {
  getConversation,
  listActiveInferenceProfileSessions,
  setConversationInferenceProfileSession,
} from "../../memory/conversation-crud.js";
import { resolveConversationId } from "../../memory/conversation-key-store.js";
import { getLogger } from "../../util/logger.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import { BadRequestError, NotFoundError } from "./errors.js";

const log = getLogger("inference-profile-session-handler");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InferenceProfileSessionResult {
  conversationId: string;
  profile: string | null;
  sessionId: string | null;
  expiresAt: number | null;
  ttlSeconds: number | null | undefined;
  replaced: {
    profile: string | null;
    sessionId: string | null;
    expiresAt: number | null;
  } | null;
}

// ---------------------------------------------------------------------------
// setInferenceProfileSession
// ---------------------------------------------------------------------------

/**
 * Open (or replace) a session-backed inference-profile override for a
 * conversation.
 *
 * - `profile === null`: clears any existing override (session or non-session).
 * - `profile` is a string: validates it against `llm.profiles`, then applies
 *   it.  TTL handling:
 *   - `ttlSeconds` is a positive number → clamp to
 *     `[1, llm.profileSession.maxTtlSeconds]`, mint a sessionId, compute
 *     expiresAt.
 *   - `ttlSeconds === null` → apply profile without a session (sticky, no
 *     expiry).  sessionId and expiresAt are both null.
 *   - `ttlSeconds === undefined` → same as null — sticky, no expiry.
 *
 * Returns `replaced` with the prior active session's details when one existed,
 * or `null` when no active session was replaced.
 */
export async function setInferenceProfileSession({
  conversationId,
  profile,
  ttlSeconds,
  sessionId: callerSessionId,
}: {
  conversationId: string;
  profile: string | null;
  ttlSeconds?: number | null;
  sessionId?: string;
}): Promise<InferenceProfileSessionResult> {
  const resolvedId = resolveConversationId(conversationId) ?? conversationId;
  const conversation = getConversation(resolvedId);
  if (!conversation) {
    throw new NotFoundError(`Conversation ${conversationId} not found`);
  }

  // Capture the prior active session (if any) so we can report it as
  // `replaced` in the response.
  let replaced: InferenceProfileSessionResult["replaced"] = null;
  if (
    conversation.inferenceProfileSessionId != null &&
    (conversation.inferenceProfileExpiresAt == null ||
      conversation.inferenceProfileExpiresAt > Date.now())
  ) {
    replaced = {
      profile: conversation.inferenceProfile,
      sessionId: conversation.inferenceProfileSessionId,
      expiresAt: conversation.inferenceProfileExpiresAt,
    };
  }

  // --- Clear path ---
  if (profile === null) {
    // Idempotency: skip the write and event when the row is already fully
    // cleared (no profile, no session, no expiry). This keeps `updatedAt`
    // stable and avoids emitting duplicate `conversation_inference_profile_updated`
    // events for retried/repeated clears, matching the behavior of
    // `closeInferenceProfileSession` when there is no active session.
    if (
      conversation.inferenceProfile == null &&
      conversation.inferenceProfileSessionId == null &&
      conversation.inferenceProfileExpiresAt == null
    ) {
      return {
        conversationId: resolvedId,
        profile: null,
        sessionId: null,
        expiresAt: null,
        ttlSeconds: null,
        replaced: null,
      };
    }
    setConversationInferenceProfileSession(resolvedId, null, null, null);
    await assistantEventHub
      .publish(
        buildAssistantEvent(
          {
            type: "conversation_inference_profile_updated",
            conversationId: resolvedId,
            profile: null,
            sessionId: null,
            expiresAt: null,
          },
          resolvedId,
        ),
      )
      .catch((err) => {
        log.warn(
          { err, conversationId: resolvedId },
          "Failed to publish conversation_inference_profile_updated event",
        );
      });
    return {
      conversationId: resolvedId,
      profile: null,
      sessionId: null,
      expiresAt: null,
      ttlSeconds: null,
      replaced,
    };
  }

  // --- Validate profile ---
  const profiles = loadConfig().llm?.profiles ?? {};
  if (!Object.prototype.hasOwnProperty.call(profiles, profile)) {
    throw new BadRequestError(
      `Profile "${profile}" is not defined in llm.profiles`,
    );
  }

  // --- Compute session fields based on ttlSeconds ---
  let newSessionId: string | null;
  let newExpiresAt: number | null;
  let clamped: number | null | undefined;

  if (typeof ttlSeconds === "number") {
    const maxTtl = loadConfig().llm?.profileSession?.maxTtlSeconds ?? 43200;
    clamped = Math.min(Math.max(1, ttlSeconds), maxTtl);
    newExpiresAt = Date.now() + clamped * 1000;
    newSessionId = callerSessionId ?? randomUUID();
  } else if (ttlSeconds === null) {
    newExpiresAt = null;
    newSessionId = null;
    clamped = null;
  } else {
    // undefined
    newExpiresAt = null;
    newSessionId = null;
    clamped = undefined;
  }

  // Skip write and event when nothing has changed.
  if (
    conversation.inferenceProfile === profile &&
    conversation.inferenceProfileSessionId === (newSessionId ?? null) &&
    conversation.inferenceProfileExpiresAt === (newExpiresAt ?? null)
  ) {
    return {
      conversationId: resolvedId,
      profile,
      sessionId: newSessionId ?? null,
      expiresAt: newExpiresAt ?? null,
      ttlSeconds: clamped,
      replaced,
    };
  }

  setConversationInferenceProfileSession(
    resolvedId,
    profile,
    newSessionId ?? null,
    newExpiresAt ?? null,
  );

  await assistantEventHub
    .publish(
      buildAssistantEvent(
        {
          type: "conversation_inference_profile_updated",
          conversationId: resolvedId,
          profile,
          sessionId: newSessionId ?? null,
          expiresAt: newExpiresAt ?? null,
        },
        resolvedId,
      ),
    )
    .catch((err) => {
      log.warn(
        { err, conversationId: resolvedId },
        "Failed to publish conversation_inference_profile_updated event",
      );
    });

  return {
    conversationId: resolvedId,
    profile,
    sessionId: newSessionId ?? null,
    expiresAt: newExpiresAt ?? null,
    ttlSeconds: clamped,
    replaced,
  };
}

// ---------------------------------------------------------------------------
// closeInferenceProfileSession
// ---------------------------------------------------------------------------

/**
 * Close the active session-backed inference-profile override for a
 * conversation.
 *
 * Only closes session-backed overrides (rows with a non-null
 * `inferenceProfileSessionId`). Sticky overrides set by the composer picker
 * (profile present, no sessionId) are left untouched — close is not the right
 * verb for those and callers should use the PUT endpoint to clear them.
 *
 * Returns `noop: true` when there was no active session to close.
 */
export async function closeInferenceProfileSession(
  conversationId: string,
): Promise<{
  conversationId: string;
  closed: { profile: string | null; sessionId: string | null } | null;
  noop: boolean;
}> {
  const resolvedId = resolveConversationId(conversationId) ?? conversationId;
  const conversation = getConversation(resolvedId);
  if (!conversation) {
    throw new NotFoundError(`Conversation ${conversationId} not found`);
  }

  const hasActiveSession =
    conversation.inferenceProfileSessionId != null &&
    (conversation.inferenceProfileExpiresAt == null ||
      conversation.inferenceProfileExpiresAt > Date.now());

  if (!hasActiveSession) {
    return { conversationId: resolvedId, closed: null, noop: true };
  }

  const result = await setInferenceProfileSession({
    conversationId: resolvedId,
    profile: null,
  });
  return {
    conversationId: result.conversationId,
    closed:
      result.replaced !== null
        ? {
            profile: result.replaced.profile,
            sessionId: result.replaced.sessionId,
          }
        : null,
    noop: result.replaced === null,
  };
}

// ---------------------------------------------------------------------------
// listInferenceProfileSessionsWithRemaining
// ---------------------------------------------------------------------------

/**
 * List all active (non-expired) session-backed inference-profile overrides,
 * augmented with `remainingSeconds` relative to `Date.now()`.
 *
 * Pass `conversationId` to narrow to a single conversation.
 */
export function listInferenceProfileSessionsWithRemaining(
  conversationId?: string,
): Array<{
  conversationId: string;
  conversationTitle: string | null;
  profile: string;
  sessionId: string;
  expiresAt: number;
  remainingSeconds: number;
}> {
  return listActiveInferenceProfileSessions(conversationId).map((row) => ({
    ...row,
    remainingSeconds: Math.max(0, Math.floor((row.expiresAt - Date.now()) / 1000)),
  }));
}
