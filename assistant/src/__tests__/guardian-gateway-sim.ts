/**
 * In-memory stand-in for the gateway-native guardian-request client
 * (`src/channels/gateway-guardian-requests.js`), for tests that exercise the
 * decision cluster without a live gateway.
 *
 * Mirrors the gateway service's semantics for the surface the decide-cluster
 * tests rely on: caller-seeded rows, pending-only code lookup, list filters,
 * the atomic decide (status CAS + recorded ACL outcome + minted session), and
 * the delivery/scope lookups used by reply routing.
 *
 * Failure injection mirrors the wire contract's atomicity:
 * - `state.decideError` — the decide throws before touching anything.
 * - `state.outcomeError` — the decide throws when it carries an `aclOutcome`,
 *   leaving the row pending (the gateway transaction rolled back).
 * - `state.readError` — throwing reads fail; `...OrNull`/`...OrEmpty`
 *   variants degrade to their fallback like the production client.
 *
 * Per the test-machinery isolation rules this helper imports nothing from
 * `src/`; the wire shapes are declared structurally and the pure derivations
 * come from the shared contract package.
 */

import { randomUUID } from "node:crypto";

import {
  deriveGuardianRequestSourceType,
  isGuardianRequestExpired,
} from "@vellumai/gateway-client";

export interface SimGuardianRequest {
  id: string;
  kind: string;
  sourceType: "voice" | "desktop" | "channel";
  sourceChannel: string | null;
  sourceConversationId: string | null;
  requesterExternalUserId: string | null;
  requesterChatId: string | null;
  guardianExternalUserId: string | null;
  guardianPrincipalId: string | null;
  callSessionId: string | null;
  pendingQuestionId: string | null;
  questionText: string | null;
  requestCode: string | null;
  toolName: string | null;
  inputDigest: string | null;
  commandPreview: string | null;
  riskLevel: string | null;
  activityText: string | null;
  executionTarget: string | null;
  requesterSignals: string | null;
  requestTrigger: string | null;
  status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  answerText: string | null;
  decidedByExternalUserId: string | null;
  decidedByPrincipalId: string | null;
  followupState: string | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SimGuardianDelivery {
  id: string;
  requestId: string;
  destinationChannel: string;
  destinationConversationId: string | null;
  destinationChatId: string | null;
  destinationMessageId: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

type SeedRequestParams = Partial<SimGuardianRequest> & { kind: string };

type SeedDeliveryParams = Partial<SimGuardianDelivery> & {
  requestId: string;
  destinationChannel: string;
};

export interface DecideParams {
  id: string;
  expectedStatus: "pending";
  status: "approved" | "denied";
  decidedByExternalUserId?: string;
  decidedByPrincipalId?: string;
  answerText?: string;
  aclOutcome?: Record<string, unknown> & { type: string };
}

export interface MintedSession {
  sessionId: string;
  secret: string;
  challengeHash: string;
  expiresAt: number;
  ttlSeconds: number;
}

let codeCounter = 0;
function generateCode(): string {
  codeCounter += 1;
  return (0xa00000 + codeCounter).toString(16).toUpperCase().slice(0, 6);
}

export function createGuardianGatewaySim() {
  const requests = new Map<string, SimGuardianRequest>();
  const deliveries: SimGuardianDelivery[] = [];

  const state = {
    decideError: null as Error | null,
    outcomeError: null as Error | null,
    readError: null as Error | null,
    /** Runs at the top of every decide — races a concurrent writer. */
    beforeDecide: null as (() => void) | null,
    decideCalls: [] as DecideParams[],
    /** ACL outcomes committed by successful decides, in order. */
    appliedOutcomes: [] as Array<Record<string, unknown> & { type: string }>,
    mintedSecret: "424242",
  };

  function reset(): void {
    requests.clear();
    deliveries.length = 0;
    state.decideError = null;
    state.outcomeError = null;
    state.readError = null;
    state.beforeDecide = null;
    state.decideCalls = [];
    state.appliedOutcomes = [];
  }

  function seedRequest(params: SeedRequestParams): SimGuardianRequest {
    const now = Date.now();
    const row: SimGuardianRequest = {
      id: params.id ?? randomUUID(),
      kind: params.kind,
      sourceChannel: params.sourceChannel ?? null,
      sourceType:
        params.sourceType ??
        deriveGuardianRequestSourceType(params.sourceChannel ?? null),
      sourceConversationId: params.sourceConversationId ?? null,
      requesterExternalUserId: params.requesterExternalUserId ?? null,
      requesterChatId: params.requesterChatId ?? null,
      guardianExternalUserId: params.guardianExternalUserId ?? null,
      guardianPrincipalId: params.guardianPrincipalId ?? null,
      callSessionId: params.callSessionId ?? null,
      pendingQuestionId: params.pendingQuestionId ?? null,
      questionText: params.questionText ?? null,
      requestCode: params.requestCode ?? generateCode(),
      toolName: params.toolName ?? null,
      inputDigest: params.inputDigest ?? null,
      commandPreview: params.commandPreview ?? null,
      riskLevel: params.riskLevel ?? null,
      activityText: params.activityText ?? null,
      executionTarget: params.executionTarget ?? null,
      requesterSignals: params.requesterSignals ?? null,
      requestTrigger: params.requestTrigger ?? null,
      status: params.status ?? "pending",
      answerText: params.answerText ?? null,
      decidedByExternalUserId: params.decidedByExternalUserId ?? null,
      decidedByPrincipalId: params.decidedByPrincipalId ?? null,
      followupState: params.followupState ?? null,
      expiresAt: params.expiresAt ?? null,
      createdAt: params.createdAt ?? now,
      updatedAt: params.updatedAt ?? now,
    };
    requests.set(row.id, row);
    return row;
  }

  function seedDelivery(params: SeedDeliveryParams): SimGuardianDelivery {
    const now = Date.now();
    const row: SimGuardianDelivery = {
      id: params.id ?? randomUUID(),
      requestId: params.requestId,
      destinationChannel: params.destinationChannel,
      destinationConversationId: params.destinationConversationId ?? null,
      destinationChatId: params.destinationChatId ?? null,
      destinationMessageId: params.destinationMessageId ?? null,
      status: params.status ?? "pending",
      createdAt: params.createdAt ?? now,
      updatedAt: params.updatedAt ?? now,
    };
    deliveries.push(row);
    return row;
  }

  function getRequest(id: string): SimGuardianRequest | null {
    const row = requests.get(id);
    return row ? { ...row } : null;
  }

  function throwIfReadError(): void {
    if (state.readError) {
      throw state.readError;
    }
  }

  // ── Client-module implementations ───────────────────────────────────

  async function getGuardianRequest(
    id: string,
  ): Promise<SimGuardianRequest | null> {
    throwIfReadError();
    return getRequest(id);
  }

  async function getGuardianRequestByCode(
    code: string,
  ): Promise<SimGuardianRequest | null> {
    throwIfReadError();
    for (const row of requests.values()) {
      if (row.requestCode === code && row.status === "pending") {
        return { ...row };
      }
    }
    return null;
  }

  async function listGuardianRequests(
    filters: Partial<{
      status: string;
      guardianExternalUserId: string;
      guardianPrincipalId: string;
      requesterExternalUserId: string;
      sourceConversationId: string;
      sourceType: string;
      sourceChannel: string;
      kind: string;
      toolName: string;
    }> = {},
  ): Promise<SimGuardianRequest[]> {
    throwIfReadError();
    return [...requests.values()]
      .filter(
        (row) =>
          (!filters.status || row.status === filters.status) &&
          (!filters.guardianExternalUserId ||
            row.guardianExternalUserId === filters.guardianExternalUserId) &&
          (!filters.guardianPrincipalId ||
            row.guardianPrincipalId === filters.guardianPrincipalId) &&
          (!filters.requesterExternalUserId ||
            row.requesterExternalUserId === filters.requesterExternalUserId) &&
          (!filters.sourceConversationId ||
            row.sourceConversationId === filters.sourceConversationId) &&
          (!filters.sourceType || row.sourceType === filters.sourceType) &&
          (!filters.sourceChannel ||
            row.sourceChannel === filters.sourceChannel) &&
          (!filters.kind || row.kind === filters.kind) &&
          (!filters.toolName || row.toolName === filters.toolName),
      )
      .map((row) => ({ ...row }));
  }

  async function updateGuardianRequest(
    id: string,
    patch: Partial<
      Pick<
        SimGuardianRequest,
        | "status"
        | "answerText"
        | "decidedByExternalUserId"
        | "decidedByPrincipalId"
        | "followupState"
        | "expiresAt"
      >
    >,
  ): Promise<void> {
    const row = requests.get(id);
    if (!row) {
      throw new Error(`sim: request ${id} not found`);
    }
    Object.assign(row, patch, { updatedAt: Date.now() });
  }

  async function decideGuardianRequest(params: DecideParams): Promise<
    | {
        applied: true;
        request: SimGuardianRequest;
        mintedSession?: MintedSession;
      }
    | { applied: false; reason: "status_conflict" }
  > {
    state.beforeDecide?.();
    state.decideCalls.push(params);
    if (state.decideError) {
      throw state.decideError;
    }
    const row = requests.get(params.id);
    if (!row || row.status !== params.expectedStatus) {
      return { applied: false, reason: "status_conflict" };
    }
    if (state.outcomeError && params.aclOutcome) {
      // Gateway transaction rollback: the CAS never lands.
      throw state.outcomeError;
    }
    row.status = params.status;
    if (params.answerText !== undefined) {
      row.answerText = params.answerText;
    }
    if (params.decidedByExternalUserId !== undefined) {
      row.decidedByExternalUserId = params.decidedByExternalUserId;
    }
    if (params.decidedByPrincipalId !== undefined) {
      row.decidedByPrincipalId = params.decidedByPrincipalId;
    }
    row.updatedAt = Date.now();
    if (params.aclOutcome) {
      state.appliedOutcomes.push(params.aclOutcome);
    }

    let mintedSession: MintedSession | undefined;
    if (params.aclOutcome?.type === "mint_outbound_session") {
      mintedSession = {
        sessionId: `sim-session-${row.id}`,
        secret: state.mintedSecret,
        challengeHash: "sim-challenge-hash",
        expiresAt: Date.now() + 600_000,
        ttlSeconds: 600,
      };
    }
    return {
      applied: true,
      request: { ...row },
      ...(mintedSession ? { mintedSession } : {}),
    };
  }

  /**
   * Test-internal terminal → pending CAS (not part of the client-module
   * surface): the store bridge uses it to mirror the gateway decide
   * transaction's rollback after a failed ACL outcome.
   */
  function reopenRequest(
    id: string,
    fromStatus: SimGuardianRequest["status"],
  ): void {
    const row = requests.get(id);
    if (!row || row.status !== fromStatus) {
      throw new Error(`sim: reopen CAS miss for ${id}`);
    }
    row.status = "pending";
    row.updatedAt = Date.now();
  }

  async function expireGuardianRequest(id: string): Promise<void> {
    const row = requests.get(id);
    if (row?.status === "pending") {
      row.status = "expired";
      row.updatedAt = Date.now();
    }
    for (const delivery of deliveries) {
      if (delivery.requestId === id) {
        delivery.status = "expired";
        delivery.updatedAt = Date.now();
      }
    }
  }

  async function expireInteractionBoundGuardianRequests(): Promise<number> {
    let expired = 0;
    const now = Date.now();
    for (const row of requests.values()) {
      if (row.status !== "pending") {
        continue;
      }
      const interactionBound =
        row.kind === "tool_approval" || row.kind === "pending_question";
      if (interactionBound || isGuardianRequestExpired(row, now)) {
        row.status = "expired";
        row.updatedAt = now;
        expired += 1;
      }
    }
    return expired;
  }

  async function sweepExpiredGuardianRequests(
    now?: number,
  ): Promise<SimGuardianRequest[]> {
    const cutoff = now ?? Date.now();
    const expired: SimGuardianRequest[] = [];
    for (const row of requests.values()) {
      if (row.status === "pending" && isGuardianRequestExpired(row, cutoff)) {
        row.status = "expired";
        row.updatedAt = cutoff;
        expired.push({ ...row });
      }
    }
    return expired;
  }

  async function createGuardianRequestDelivery(
    params: SeedDeliveryParams,
  ): Promise<SimGuardianDelivery> {
    return seedDelivery(params);
  }

  async function updateGuardianRequestDelivery(
    id: string,
    patch: Partial<
      Pick<SimGuardianDelivery, "status" | "destinationMessageId">
    >,
  ): Promise<void> {
    const row = deliveries.find((d) => d.id === id);
    if (!row) {
      throw new Error(`sim: delivery ${id} not found`);
    }
    Object.assign(row, patch, { updatedAt: Date.now() });
  }

  async function listGuardianRequestDeliveries(
    requestId: string,
  ): Promise<SimGuardianDelivery[]> {
    throwIfReadError();
    return deliveries
      .filter((d) => d.requestId === requestId)
      .map((d) => ({ ...d }));
  }

  async function getPendingRequestByDestinationMessage(
    channel: string,
    chatId: string,
    messageId: string,
  ): Promise<SimGuardianRequest | null> {
    throwIfReadError();
    const delivery = deliveries.find(
      (d) =>
        d.destinationChannel === channel &&
        d.destinationChatId === chatId &&
        d.destinationMessageId === messageId,
    );
    if (!delivery) {
      return null;
    }
    const request = requests.get(delivery.requestId);
    return request?.status === "pending" ? { ...request } : null;
  }

  async function listPendingRequestsByDestination(params: {
    channel?: string;
    chatId?: string;
    conversationId?: string;
  }): Promise<SimGuardianRequest[]> {
    throwIfReadError();
    const matched = deliveries.filter((d) => {
      if (params.conversationId) {
        return (
          d.destinationConversationId === params.conversationId &&
          (!params.channel || d.destinationChannel === params.channel)
        );
      }
      return (
        d.destinationChannel === params.channel &&
        d.destinationChatId === params.chatId
      );
    });
    const seen = new Set<string>();
    const result: SimGuardianRequest[] = [];
    for (const delivery of matched) {
      if (seen.has(delivery.requestId)) {
        continue;
      }
      seen.add(delivery.requestId);
      const request = requests.get(delivery.requestId);
      if (request?.status === "pending") {
        result.push({ ...request });
      }
    }
    return result;
  }

  async function listPendingRequestsByScope(
    conversationId: string,
    channel?: string,
  ): Promise<SimGuardianRequest[]> {
    throwIfReadError();
    const now = Date.now();
    const seen = new Set<string>();
    const result: SimGuardianRequest[] = [];
    for (const row of requests.values()) {
      if (
        row.status === "pending" &&
        row.sourceConversationId === conversationId &&
        !isGuardianRequestExpired(row, now)
      ) {
        seen.add(row.id);
        result.push({ ...row });
      }
    }
    const byDestination = await listPendingRequestsByDestination({
      conversationId,
      ...(channel ? { channel } : {}),
    });
    for (const row of byDestination) {
      if (!seen.has(row.id) && !isGuardianRequestExpired(row, now)) {
        seen.add(row.id);
        result.push(row);
      }
    }
    return result;
  }

  async function isGuardianRequestInScope(
    requestId: string,
    conversationId: string,
    channel?: string,
  ): Promise<boolean> {
    throwIfReadError();
    const request = requests.get(requestId);
    if (!request) {
      return false;
    }
    if (request.sourceConversationId === conversationId) {
      return true;
    }
    return deliveries.some(
      (d) =>
        d.requestId === requestId &&
        d.destinationConversationId === conversationId &&
        (!channel || d.destinationChannel === channel),
    );
  }

  async function getPendingRequestByCallSession(
    callSessionId: string,
  ): Promise<SimGuardianRequest | null> {
    throwIfReadError();
    const rows = [...requests.values()]
      .filter(
        (r) => r.callSessionId === callSessionId && r.status === "pending",
      )
      .sort((a, b) => b.createdAt - a.createdAt);
    return rows[0] ? { ...rows[0] } : null;
  }

  async function getRequestByPendingQuestion(
    pendingQuestionId: string,
  ): Promise<SimGuardianRequest | null> {
    throwIfReadError();
    for (const row of requests.values()) {
      if (row.pendingQuestionId === pendingQuestionId) {
        return { ...row };
      }
    }
    return null;
  }

  async function createGuardianRequest(
    params: SeedRequestParams & { id: string; guardianPrincipalId: string },
  ): Promise<SimGuardianRequest> {
    return seedRequest(params);
  }

  function degrade<Args extends unknown[], T>(
    read: (...args: Args) => Promise<T>,
    fallback: T,
  ): (...args: Args) => Promise<T> {
    return async (...args: Args): Promise<T> => {
      try {
        return await read(...args);
      } catch {
        return fallback;
      }
    };
  }

  /**
   * Drop-in replacement for the gateway-guardian-requests client module —
   * same surface: reads whose only callers are deny paths appear solely as
   * their degrading variant.
   */
  const module = {
    createGuardianRequest,
    getGuardianRequest,
    getGuardianRequestOrNull: degrade(getGuardianRequest, null),
    getGuardianRequestByCodeOrNull: degrade(getGuardianRequestByCode, null),
    listGuardianRequestsOrEmpty: degrade(listGuardianRequests, []),
    updateGuardianRequest,
    decideGuardianRequest,
    expireGuardianRequest,
    expireInteractionBoundGuardianRequests,
    sweepExpiredGuardianRequests,
    createGuardianRequestDelivery,
    updateGuardianRequestDelivery,
    listGuardianRequestDeliveries,
    listGuardianRequestDeliveriesOrEmpty: degrade(
      listGuardianRequestDeliveries,
      [],
    ),
    getPendingRequestByDestinationMessageOrNull: degrade(
      getPendingRequestByDestinationMessage,
      null,
    ),
    listPendingRequestsByDestinationOrEmpty: degrade(
      listPendingRequestsByDestination,
      [],
    ),
    listPendingRequestsByScope,
    listPendingRequestsByScopeOrEmpty: degrade(listPendingRequestsByScope, []),
    isGuardianRequestInScopeOrFalse: degrade(isGuardianRequestInScope, false),
    getPendingRequestByCallSession,
    getPendingRequestByCallSessionOrNull: degrade(
      getPendingRequestByCallSession,
      null,
    ),
    getRequestByPendingQuestionOrNull: degrade(
      getRequestByPendingQuestion,
      null,
    ),
  };

  return {
    requests,
    deliveries,
    state,
    reset,
    seedRequest,
    seedDelivery,
    getRequest,
    reopenRequest,
    module,
  };
}

export type GuardianGatewaySim = ReturnType<typeof createGuardianGatewaySim>;
