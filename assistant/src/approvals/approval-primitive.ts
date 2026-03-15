/**
 * Unified approval primitive for scoped approval grants.
 *
 * All producers (voice guardian-action minter, channel guardian approval
 * interception) and consumers (tool executor grant checks) must go through
 * this module instead of calling the storage layer directly.  This enforces
 * all scope constraints in one place and provides structured logging for
 * mint/consume hit/miss diagnostics.
 *
 * Storage remains in `scoped_approval_grants` via the existing CRUD module;
 * this primitive wraps that layer with a unified API surface.
 */

import {
  _internal,
  type ConsumeByRequestIdResult,
  type ConsumeByToolSignatureResult,
  type ScopedApprovalGrant,
} from "../memory/scoped-approval-grants.js";

const {
  createScopedApprovalGrant,
  consumeScopedApprovalGrantByRequestId,
  consumeScopedApprovalGrantByToolSignature,
} = _internal;
import { getLogger } from "../util/logger.js";

const log = getLogger("approval-primitive");

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

export interface MintGrantParams {
  scopeMode: "request_id" | "tool_signature";
  requestId?: string | null;
  toolName?: string | null;
  inputDigest?: string | null;
  requestChannel: string;
  decisionChannel: string;
  executionChannel?: string | null;
  conversationId?: string | null;
  callSessionId?: string | null;
  requesterExternalUserId?: string | null;
  guardianExternalUserId?: string | null;
  expiresAt: number;
}

export type MintGrantResult =
  | { ok: true; grant: ScopedApprovalGrant }
  | {
      ok: false;
      reason: "missing_request_id" | "missing_tool_fields" | "storage_error";
      error?: unknown;
    };

/**
 * Mint a scoped approval grant from a guardian decision.
 *
 * Validates scope-mode-specific field requirements before delegating to the
 * storage layer:
 *   - `request_id` scope requires a non-null `requestId`.
 *   - `tool_signature` scope requires both `toolName` and `inputDigest`.
 *
 * Returns a discriminated result so callers can inspect failure reasons
 * without catching exceptions.
 */
export function mintGrantFromDecision(
  params: MintGrantParams,
): MintGrantResult {
  // Scope-mode field validation
  if (params.scopeMode === "request_id" && !params.requestId) {
    log.warn(
      {
        event: "approval_primitive_mint_rejected",
        reason: "missing_request_id",
        scopeMode: params.scopeMode,
        requestChannel: params.requestChannel,
        decisionChannel: params.decisionChannel,
      },
      "Mint rejected: request_id scope requires a non-null requestId",
    );
    return { ok: false, reason: "missing_request_id" };
  }

  if (
    params.scopeMode === "tool_signature" &&
    (!params.toolName || !params.inputDigest)
  ) {
    log.warn(
      {
        event: "approval_primitive_mint_rejected",
        reason: "missing_tool_fields",
        scopeMode: params.scopeMode,
        toolName: params.toolName ?? null,
        inputDigest: params.inputDigest ?? null,
        requestChannel: params.requestChannel,
        decisionChannel: params.decisionChannel,
      },
      "Mint rejected: tool_signature scope requires both toolName and inputDigest",
    );
    return { ok: false, reason: "missing_tool_fields" };
  }

  try {
    const grant = createScopedApprovalGrant({
      scopeMode: params.scopeMode,
      requestId: params.requestId ?? null,
      toolName: params.toolName ?? null,
      inputDigest: params.inputDigest ?? null,
      requestChannel: params.requestChannel,
      decisionChannel: params.decisionChannel,
      executionChannel: params.executionChannel ?? null,
      conversationId: params.conversationId ?? null,
      callSessionId: params.callSessionId ?? null,
      requesterExternalUserId: params.requesterExternalUserId ?? null,
      guardianExternalUserId: params.guardianExternalUserId ?? null,
      expiresAt: params.expiresAt,
    });

    log.info(
      {
        event: "approval_primitive_mint_success",
        grantId: grant.id,
        scopeMode: params.scopeMode,
        toolName: params.toolName ?? null,
        requestId: params.requestId ?? null,
        requestChannel: params.requestChannel,
        decisionChannel: params.decisionChannel,
        conversationId: params.conversationId ?? null,
        callSessionId: params.callSessionId ?? null,
        expiresAt: params.expiresAt,
      },
      "Approval grant minted",
    );

    return { ok: true, grant };
  } catch (error) {
    log.error(
      {
        event: "approval_primitive_mint_error",
        scopeMode: params.scopeMode,
        toolName: params.toolName ?? null,
        err: error,
      },
      "Failed to mint approval grant (storage error)",
    );
    return { ok: false, reason: "storage_error", error };
  }
}

// ---------------------------------------------------------------------------
// Consume
// ---------------------------------------------------------------------------

export interface ConsumeByRequestIdParams {
  requestId: string;
  consumingRequestId: string;
  now?: number;
}

export interface ConsumeByToolSignatureParams {
  toolName: string;
  inputDigest: string;
  consumingRequestId: string;
  executionChannel?: string;
  conversationId?: string;
  callSessionId?: string;
  requesterExternalUserId?: string;
  now?: number;
}

export type ConsumeGrantResult =
  | { ok: true; grant: ScopedApprovalGrant }
  | {
      ok: false;
      reason:
        | "no_match"
        | "scope_mismatch"
        | "expired"
        | "already_consumed"
        | "aborted";
    };

export interface ConsumeGrantParams {
  requestId?: string;
  toolName: string;
  inputDigest: string;
  consumingRequestId: string;
  executionChannel?: string;
  conversationId?: string;
  callSessionId?: string;
  requesterExternalUserId?: string;
  now?: number;
}

/**
 * Single synchronous attempt to consume a scoped approval grant.
 *
 * Tries `request_id` mode first when a requestId is provided, then falls
 * back to `tool_signature` mode.  This mirrors the priority ordering at
 * the consume site: an exact request-bound grant takes precedence over a
 * tool-signature grant.
 *
 * This is an internal helper — callers should use {@link consumeGrantForInvocation}
 * which adds retry polling to handle the voice pipeline race condition.
 */
function consumeGrantSync(params: ConsumeGrantParams): ConsumeGrantResult {
  // Try request_id mode first when a requestId is provided
  if (params.requestId) {
    const reqResult: ConsumeByRequestIdResult =
      consumeScopedApprovalGrantByRequestId(
        params.requestId,
        params.consumingRequestId,
        params.now,
      );

    if (reqResult.ok && reqResult.grant) {
      log.info(
        {
          event: "approval_primitive_consume_hit",
          mode: "request_id",
          grantId: reqResult.grant.id,
          requestId: params.requestId,
          consumingRequestId: params.consumingRequestId,
          toolName: params.toolName,
        },
        "Approval grant consumed via request_id",
      );
      return { ok: true, grant: reqResult.grant };
    }

    log.info(
      {
        event: "approval_primitive_consume_miss",
        mode: "request_id",
        reason: "no_match",
        requestId: params.requestId,
        consumingRequestId: params.consumingRequestId,
        toolName: params.toolName,
      },
      "No request_id grant match, falling through to tool_signature",
    );
  }

  // Fall back to tool_signature mode
  const sigResult: ConsumeByToolSignatureResult =
    consumeScopedApprovalGrantByToolSignature({
      toolName: params.toolName,
      inputDigest: params.inputDigest,
      consumingRequestId: params.consumingRequestId,
      executionChannel: params.executionChannel,
      conversationId: params.conversationId,
      callSessionId: params.callSessionId,
      requesterExternalUserId: params.requesterExternalUserId,
      now: params.now,
    });

  if (sigResult.ok && sigResult.grant) {
    log.info(
      {
        event: "approval_primitive_consume_hit",
        mode: "tool_signature",
        grantId: sigResult.grant.id,
        toolName: params.toolName,
        consumingRequestId: params.consumingRequestId,
        conversationId: params.conversationId ?? null,
        callSessionId: params.callSessionId ?? null,
      },
      "Approval grant consumed via tool_signature",
    );
    return { ok: true, grant: sigResult.grant };
  }

  log.info(
    {
      event: "approval_primitive_consume_miss",
      mode: "tool_signature",
      reason: "no_match",
      toolName: params.toolName,
      consumingRequestId: params.consumingRequestId,
      conversationId: params.conversationId ?? null,
      callSessionId: params.callSessionId ?? null,
      executionChannel: params.executionChannel ?? null,
    },
    "No tool_signature grant match found",
  );

  return { ok: false, reason: "no_match" };
}

// ---------------------------------------------------------------------------
// Public consume API (with retry for voice pipeline race condition)
// ---------------------------------------------------------------------------

/** Default polling interval for grant retry (ms). */
const GRANT_RETRY_INTERVAL_MS = 250;
/** Default maximum wait time for grant retry (ms). */
const GRANT_RETRY_MAX_WAIT_MS = 10_000;

/**
 * Consume a scoped approval grant for a tool invocation.
 *
 * Performs a synchronous lookup first and returns immediately when a
 * matching grant exists.  When the first attempt misses, retries with
 * polling to handle the voice pipeline race condition where the grant
 * may still be in-flight: `answerCall()` triggers the voice turn as
 * fire-and-forget, and the voice LLM can attempt tool execution before
 * `tryMintGuardianActionGrant`'s classifier finishes minting the
 * grant.  Polling bridges this timing gap without changing the
 * fire-and-forget architecture.
 */
export async function consumeGrantForInvocation(
  params: ConsumeGrantParams,
  options?: { maxWaitMs?: number; intervalMs?: number; signal?: AbortSignal },
): Promise<ConsumeGrantResult> {
  // Fast path: try once synchronously — covers the common case where the
  // grant already exists.
  const first = consumeGrantSync(params);
  if (first.ok) {
    return first;
  }

  // When maxWaitMs is 0, skip retry entirely — used by non-voice channels
  // where grant-minting race conditions don't apply.
  const maxWait = options?.maxWaitMs ?? GRANT_RETRY_MAX_WAIT_MS;
  if (maxWait <= 0) {
    return first;
  }

  const interval = options?.intervalMs ?? GRANT_RETRY_INTERVAL_MS;
  const deadline = Date.now() + maxWait;

  log.info(
    {
      event: "approval_primitive_consume_retry_start",
      toolName: params.toolName,
      consumingRequestId: params.consumingRequestId,
      maxWaitMs: maxWait,
      intervalMs: interval,
    },
    "Grant not found on first attempt; starting retry polling",
  );

  const signal = options?.signal;

  while (Date.now() < deadline) {
    // Exit promptly on cancellation (e.g. voice barge-in) so the session
    // can tear down the current turn without waiting for the full timeout.
    // Returns 'aborted' (not 'no_match') so callers can distinguish
    // cancellation from a genuine grant miss.
    if (signal?.aborted) {
      return { ok: false, reason: "aborted" };
    }

    await new Promise((resolve) => setTimeout(resolve, interval));

    if (signal?.aborted) {
      return { ok: false, reason: "aborted" };
    }

    const result = consumeGrantSync(params);
    if (result.ok) {
      log.info(
        {
          event: "approval_primitive_consume_retry_hit",
          toolName: params.toolName,
          consumingRequestId: params.consumingRequestId,
          grantId: result.grant.id,
          elapsedMs: maxWait - (deadline - Date.now()),
        },
        "Grant found after retry polling",
      );
      return result;
    }
  }

  log.info(
    {
      event: "approval_primitive_consume_retry_timeout",
      toolName: params.toolName,
      consumingRequestId: params.consumingRequestId,
      maxWaitMs: maxWait,
    },
    "Grant retry polling timed out — no matching grant found",
  );

  return { ok: false, reason: "no_match" };
}
