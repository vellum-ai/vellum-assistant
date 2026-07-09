/**
 * Tests for the shared guardian-request contract: round-trips of
 * representative payloads and the method-name pin — every method carries the
 * `guardian_requests_` prefix, distinct from the daemon's client-facing
 * `guardian_actions_*` operationIds.
 */

import { describe, expect, test } from "bun:test";

import {
  CreateGuardianRequestDeliveryIpcParamsSchema,
  CreateGuardianRequestIpcParamsSchema,
  DecideGuardianRequestIpcParamsSchema,
  DecideGuardianRequestIpcResponseSchema,
  ExpireGuardianRequestIpcParamsSchema,
  ExpireInteractionBoundIpcResponseSchema,
  GetGuardianRequestByCallSessionIpcParamsSchema,
  GetGuardianRequestByDestinationMessageIpcParamsSchema,
  GetGuardianRequestByPendingQuestionIpcParamsSchema,
  GUARDIAN_REQUESTS_IPC_METHODS,
  GuardianRequestAclOutcomeSchema,
  GuardianRequestDeliverySchema,
  GuardianRequestInScopeIpcParamsSchema,
  GuardianRequestInScopeIpcResponseSchema,
  GuardianRequestListIpcResponseSchema,
  GuardianRequestLookupIpcResponseSchema,
  GuardianRequestMutationIpcResponseSchema,
  GuardianRequestSchema,
  ListGuardianRequestsIpcParamsSchema,
  ListPendingGuardianRequestsByDestinationIpcParamsSchema,
  ListPendingGuardianRequestsByScopeIpcParamsSchema,
  ReopenGuardianRequestIpcParamsSchema,
  SweepExpiredGuardianRequestsIpcParamsSchema,
  SweepExpiredGuardianRequestsIpcResponseSchema,
  UpdateGuardianRequestIpcParamsSchema,
  type GuardianRequestWire,
} from "../guardian-request-contract.js";

describe("IPC method names", () => {
  test("exposes 19 unique methods under the guardian_requests_ prefix", () => {
    const methods = Object.values(GUARDIAN_REQUESTS_IPC_METHODS);
    expect(methods).toHaveLength(19);
    expect(new Set(methods).size).toBe(19);
    for (const method of methods) {
      expect(method).toMatch(/^guardian_requests_[a-z_]+$/);
    }
  });

  test("collides with no client-facing guardian_actions_* operationId", () => {
    for (const method of Object.values(GUARDIAN_REQUESTS_IPC_METHODS)) {
      expect(method.startsWith("guardian_actions")).toBe(false);
      expect(method).not.toBe("guardian_actions_pending");
      expect(method).not.toBe("guardian_actions_decision");
    }
  });
});

const accessRequest: GuardianRequestWire = {
  id: "access-req-self-telegram-tg-user-1-1700000000000",
  kind: "access_request",
  sourceType: "channel",
  sourceChannel: "telegram",
  sourceConversationId: "conv-1",
  requesterExternalUserId: "tg-user-1",
  requesterChatId: "tg-chat-1",
  guardianExternalUserId: "tg-guardian-1",
  guardianPrincipalId: "principal-1",
  callSessionId: null,
  pendingQuestionId: null,
  questionText: null,
  requestCode: "A1B2C3",
  toolName: null,
  inputDigest: null,
  commandPreview: null,
  riskLevel: null,
  activityText: null,
  executionTarget: null,
  requesterSignals: '{"isBot":false,"isStranger":true,"isRestricted":false}',
  requestTrigger: "denied",
  status: "pending",
  answerText: null,
  decidedByExternalUserId: null,
  decidedByPrincipalId: null,
  followupState: null,
  expiresAt: 1_700_000_600_000,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const pendingQuestion: GuardianRequestWire = {
  ...accessRequest,
  id: "req-2",
  kind: "pending_question",
  sourceType: "voice",
  sourceChannel: "phone",
  sourceConversationId: null,
  requesterExternalUserId: "+15550100",
  requesterChatId: "+15550100",
  callSessionId: "call-1",
  pendingQuestionId: "question-1",
  questionText: "Can I share the calendar?",
  requesterSignals: null,
  requestTrigger: null,
  status: "approved",
  answerText: "Yes, go ahead",
  decidedByExternalUserId: "tg-guardian-1",
  decidedByPrincipalId: "principal-1",
  expiresAt: null,
};

describe("GuardianRequestSchema", () => {
  test("round-trips channel and voice requests", () => {
    expect(GuardianRequestSchema.parse(accessRequest)).toEqual(accessRequest);
    expect(GuardianRequestSchema.parse(pendingQuestion)).toEqual(
      pendingQuestion,
    );
  });

  test("rejects unknown status and sourceType; kind stays open for legacy rows", () => {
    expect(() =>
      GuardianRequestSchema.parse({ ...accessRequest, status: "answered" }),
    ).toThrow();
    // The physical column accepts any kind; reads round-trip legacy rows.
    expect(
      GuardianRequestSchema.parse({ ...accessRequest, kind: "status_update" })
        .kind,
    ).toBe("status_update");
    expect(() =>
      GuardianRequestSchema.parse({ ...accessRequest, sourceType: "phone" }),
    ).toThrow();
    // Creates stay restricted to the decisionable kind enum.
    expect(() =>
      CreateGuardianRequestIpcParamsSchema.parse({
        id: "req-x",
        kind: "status_update",
        guardianPrincipalId: "principal-1",
      }),
    ).toThrow();
  });

  test("lookup and list responses accept DTO, null, and arrays", () => {
    expect(GuardianRequestLookupIpcResponseSchema.parse(accessRequest)).toEqual(
      accessRequest,
    );
    expect(GuardianRequestLookupIpcResponseSchema.parse(null)).toBeNull();
    expect(
      GuardianRequestListIpcResponseSchema.parse([
        accessRequest,
        pendingQuestion,
      ]),
    ).toHaveLength(2);
  });
});

describe("GuardianRequestDeliverySchema", () => {
  test("round-trips a delivery record", () => {
    const delivery = {
      id: "delivery-1",
      requestId: accessRequest.id,
      destinationChannel: "telegram",
      destinationConversationId: "conv-guardian-1",
      destinationChatId: "tg-chat-guardian",
      destinationMessageId: "msg-42",
      status: "sent",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
    };
    expect(GuardianRequestDeliverySchema.parse(delivery)).toEqual(delivery);
  });
});

describe("create IPC schemas", () => {
  test("round-trips full and minimal params; id is required", () => {
    const full = {
      id: accessRequest.id,
      kind: "access_request",
      sourceChannel: "telegram",
      sourceConversationId: "conv-1",
      requesterExternalUserId: "tg-user-1",
      requesterChatId: "tg-chat-1",
      guardianExternalUserId: "tg-guardian-1",
      guardianPrincipalId: "principal-1",
      requestCode: "A1B2C3",
      requesterSignals: '{"isBot":false}',
      requestTrigger: "admitted",
      expiresAt: 1_700_000_600_000,
    } as const;
    expect(CreateGuardianRequestIpcParamsSchema.parse(full)).toEqual(full);

    const minimal = {
      id: "req-3",
      kind: "tool_approval",
      guardianPrincipalId: "principal-1",
    } as const;
    expect(CreateGuardianRequestIpcParamsSchema.parse(minimal)).toEqual(
      minimal,
    );

    expect(() =>
      CreateGuardianRequestIpcParamsSchema.parse({
        kind: "tool_approval",
        guardianPrincipalId: "principal-1",
      }),
    ).toThrow();
    expect(() =>
      CreateGuardianRequestIpcParamsSchema.parse({
        id: "",
        kind: "tool_approval",
        guardianPrincipalId: "principal-1",
      }),
    ).toThrow();
    // Every admitted kind is decisionable: the principal is non-optional.
    expect(() =>
      CreateGuardianRequestIpcParamsSchema.parse({
        id: "req-3",
        kind: "tool_approval",
      }),
    ).toThrow();
  });
});

describe("list + update IPC schemas", () => {
  test("list accepts the 9-filter set and rejects a bad sourceType", () => {
    const filters = {
      status: "pending",
      guardianExternalUserId: "tg-guardian-1",
      guardianPrincipalId: "principal-1",
      requesterExternalUserId: "tg-user-1",
      sourceConversationId: "conv-1",
      sourceType: "channel",
      sourceChannel: "telegram",
      kind: "access_request",
      toolName: "Bash",
    } as const;
    expect(ListGuardianRequestsIpcParamsSchema.parse(filters)).toEqual(filters);
    expect(ListGuardianRequestsIpcParamsSchema.parse({})).toEqual({});
    expect(() =>
      ListGuardianRequestsIpcParamsSchema.parse({ sourceType: "phone" }),
    ).toThrow();
  });

  test("update accepts a partial patch incl. null followupState", () => {
    const params = {
      id: "req-1",
      patch: {
        followupState: null,
        answerText: "noted",
      },
    };
    expect(UpdateGuardianRequestIpcParamsSchema.parse(params)).toEqual(params);
    expect(GuardianRequestMutationIpcResponseSchema.parse({ ok: true })).toEqual(
      { ok: true },
    );
    expect(() =>
      GuardianRequestMutationIpcResponseSchema.parse({ ok: false }),
    ).toThrow();
  });
});

describe("decide IPC schemas", () => {
  test("aclOutcome discriminates all four variants", () => {
    const activate = {
      type: "activate_member",
      sourceChannel: "phone",
      externalUserId: "+15550100",
      externalChatId: "+15550100",
      verifiedVia: "manual",
    } as const;
    expect(GuardianRequestAclOutcomeSchema.parse(activate)).toEqual(activate);

    const seed = {
      type: "seed_unverified",
      sourceChannel: "telegram",
      externalUserId: "tg-user-1",
      displayName: "Sender",
    } as const;
    expect(GuardianRequestAclOutcomeSchema.parse(seed)).toEqual(seed);

    const block = {
      type: "block",
      sourceChannel: "telegram",
      externalUserId: "tg-user-1",
      reason: "introduction_block",
    } as const;
    expect(GuardianRequestAclOutcomeSchema.parse(block)).toEqual(block);

    const mint = {
      type: "mint_outbound_session",
      channel: "telegram",
      expectedExternalUserId: "tg-user-1",
      expectedChatId: "tg-chat-1",
      identityBindingStatus: "bound",
      destinationAddress: "tg-chat-1",
      verificationPurpose: "trusted_contact",
    } as const;
    expect(GuardianRequestAclOutcomeSchema.parse(mint)).toEqual(mint);

    expect(() =>
      GuardianRequestAclOutcomeSchema.parse({ type: "revoke_everything" }),
    ).toThrow();
  });

  test("params round-trip with and without an aclOutcome", () => {
    const withOutcome = {
      id: "req-1",
      expectedStatus: "pending",
      status: "denied",
      decidedByExternalUserId: "tg-guardian-1",
      decidedByPrincipalId: "principal-1",
      aclOutcome: {
        type: "block",
        sourceChannel: "telegram",
        externalUserId: "tg-user-1",
      },
    } as const;
    expect(DecideGuardianRequestIpcParamsSchema.parse(withOutcome)).toEqual(
      withOutcome,
    );

    const plainCas = {
      id: "req-2",
      expectedStatus: "pending",
      status: "denied",
      answerText: "not now",
    } as const;
    expect(DecideGuardianRequestIpcParamsSchema.parse(plainCas)).toEqual(
      plainCas,
    );
  });

  test("rejects an aclOutcome that contradicts the decision status", () => {
    const activate = {
      type: "activate_member",
      sourceChannel: "telegram",
      externalUserId: "tg-user-1",
      verifiedVia: "guardian_approval",
    } as const;
    expect(
      DecideGuardianRequestIpcParamsSchema.parse({
        id: "req-1",
        expectedStatus: "pending",
        status: "approved",
        aclOutcome: activate,
      }),
    ).toMatchObject({ status: "approved" });
    expect(() =>
      DecideGuardianRequestIpcParamsSchema.parse({
        id: "req-1",
        expectedStatus: "pending",
        status: "denied",
        aclOutcome: activate,
      }),
    ).toThrow();
    expect(() =>
      DecideGuardianRequestIpcParamsSchema.parse({
        id: "req-1",
        expectedStatus: "pending",
        status: "approved",
        aclOutcome: {
          type: "block",
          sourceChannel: "telegram",
          externalUserId: "tg-user-1",
        },
      }),
    ).toThrow();
  });

  test("only resolves pending to approved/denied", () => {
    expect(() =>
      DecideGuardianRequestIpcParamsSchema.parse({
        id: "req-1",
        expectedStatus: "approved",
        status: "pending",
      }),
    ).toThrow();
    expect(() =>
      DecideGuardianRequestIpcParamsSchema.parse({
        id: "req-1",
        expectedStatus: "pending",
        status: "expired",
      }),
    ).toThrow();
  });

  test("response discriminates applied from status_conflict", () => {
    const applied = {
      applied: true,
      request: { ...accessRequest, status: "approved" },
      mintedSession: {
        sessionId: "sess-1",
        secret: "123456",
        challengeHash: "hash",
        expiresAt: 1_700_000_600_000,
        ttlSeconds: 600,
      },
    } as const;
    expect(DecideGuardianRequestIpcResponseSchema.parse(applied)).toEqual(
      applied,
    );

    const appliedNoMint = {
      applied: true,
      request: { ...accessRequest, status: "denied" },
    } as const;
    expect(DecideGuardianRequestIpcResponseSchema.parse(appliedNoMint)).toEqual(
      appliedNoMint,
    );

    const conflict = { applied: false, reason: "status_conflict" } as const;
    expect(DecideGuardianRequestIpcResponseSchema.parse(conflict)).toEqual(
      conflict,
    );
    expect(() =>
      DecideGuardianRequestIpcResponseSchema.parse({
        applied: false,
        reason: "gateway_down",
      }),
    ).toThrow();
  });
});

describe("reopen + expiry IPC schemas", () => {
  test("reopen, expire, and sweep round-trip", () => {
    const reopen = { id: "req-1", fromStatus: "approved" } as const;
    expect(ReopenGuardianRequestIpcParamsSchema.parse(reopen)).toEqual(reopen);

    expect(ExpireGuardianRequestIpcParamsSchema.parse({ id: "req-1" })).toEqual(
      { id: "req-1" },
    );

    expect(
      SweepExpiredGuardianRequestsIpcParamsSchema.parse({
        now: 1_700_000_000_000,
      }),
    ).toEqual({ now: 1_700_000_000_000 });
    expect(SweepExpiredGuardianRequestsIpcParamsSchema.parse({})).toEqual({});
    expect(
      SweepExpiredGuardianRequestsIpcResponseSchema.parse({
        expired: ["req-1", "req-2"],
      }),
    ).toEqual({ expired: ["req-1", "req-2"] });

    expect(
      ExpireInteractionBoundIpcResponseSchema.parse({ expired: 3 }),
    ).toEqual({ expired: 3 });
    expect(() =>
      ExpireInteractionBoundIpcResponseSchema.parse({ expired: 3.5 }),
    ).toThrow();
  });
});

describe("delivery + destination IPC schemas", () => {
  test("create_delivery round-trips with and without a caller id", () => {
    const full = {
      id: "delivery-1",
      requestId: "req-1",
      destinationChannel: "telegram",
      destinationConversationId: "conv-guardian-1",
      destinationChatId: "tg-chat-guardian",
      destinationMessageId: "msg-42",
      status: "sent",
    };
    expect(CreateGuardianRequestDeliveryIpcParamsSchema.parse(full)).toEqual(
      full,
    );
    const minimal = { requestId: "req-1", destinationChannel: "vellum" };
    expect(CreateGuardianRequestDeliveryIpcParamsSchema.parse(minimal)).toEqual(
      minimal,
    );
  });

  test("get_by_destination_message requires all three keys", () => {
    const params = {
      channel: "telegram",
      chatId: "tg-chat-guardian",
      messageId: "msg-42",
    };
    expect(
      GetGuardianRequestByDestinationMessageIpcParamsSchema.parse(params),
    ).toEqual(params);
    expect(() =>
      GetGuardianRequestByDestinationMessageIpcParamsSchema.parse({
        channel: "telegram",
        chatId: "tg-chat-guardian",
      }),
    ).toThrow();
  });

  test("list_pending_by_destination accepts either addressing form", () => {
    const byConversation = { conversationId: "conv-1", channel: "telegram" };
    expect(
      ListPendingGuardianRequestsByDestinationIpcParamsSchema.parse(
        byConversation,
      ),
    ).toEqual(byConversation);

    const byChat = { channel: "telegram", chatId: "tg-chat-guardian" };
    expect(
      ListPendingGuardianRequestsByDestinationIpcParamsSchema.parse(byChat),
    ).toEqual(byChat);

    expect(() =>
      ListPendingGuardianRequestsByDestinationIpcParamsSchema.parse({
        chatId: "tg-chat-guardian",
      }),
    ).toThrow();
    expect(() =>
      ListPendingGuardianRequestsByDestinationIpcParamsSchema.parse({}),
    ).toThrow();
  });

  test("scope schemas round-trip", () => {
    const scope = { conversationId: "conv-1", channel: "telegram" };
    expect(
      ListPendingGuardianRequestsByScopeIpcParamsSchema.parse(scope),
    ).toEqual(scope);

    const inScope = {
      requestId: "req-1",
      conversationId: "conv-1",
      channel: "telegram",
    };
    expect(GuardianRequestInScopeIpcParamsSchema.parse(inScope)).toEqual(
      inScope,
    );
    expect(
      GuardianRequestInScopeIpcResponseSchema.parse({ inScope: true }),
    ).toEqual({ inScope: true });
  });

  test("call-session lookups round-trip and reject empty ids", () => {
    expect(
      GetGuardianRequestByCallSessionIpcParamsSchema.parse({
        callSessionId: "call-1",
      }),
    ).toEqual({ callSessionId: "call-1" });
    expect(() =>
      GetGuardianRequestByCallSessionIpcParamsSchema.parse({
        callSessionId: "",
      }),
    ).toThrow();

    expect(
      GetGuardianRequestByPendingQuestionIpcParamsSchema.parse({
        pendingQuestionId: "pq-1",
      }),
    ).toEqual({ pendingQuestionId: "pq-1" });
    expect(() =>
      GetGuardianRequestByPendingQuestionIpcParamsSchema.parse({}),
    ).toThrow();
  });
});
