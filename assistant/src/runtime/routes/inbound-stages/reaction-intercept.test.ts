/**
 * Reaction-intercept trust classification from the gateway-stamped verdict.
 *
 * The intercept reads the reactor's trust solely from
 * `sourceMetadata.trustVerdict` (via `actorTrustContextFromVerdict`) — no
 * local resolver, cache warm, or IPC reads. Pins the dispositions: an
 * admitted actor's reaction is recorded against the reacted message's
 * conversation whatever their trust class, and unknown / missing / failed /
 * contradictory verdicts drop fail-closed before any write.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { TrustVerdict } from "@vellumai/gateway-client";

const GUARDIAN_USER_ID = "U_GUARDIAN_VERDICT";
const MEMBER_USER_ID = "U_MEMBER_VERDICT";
const SLACK_CHANNEL_ID = "C0VERDICT";

// ---------------------------------------------------------------------------
// Choreography spies: the intercept must make ZERO gateway IPC reads,
// guardian-delivery reads, or member-verdict cache writes.
// ---------------------------------------------------------------------------

let ipcCalls: string[] = [];
mock.module("../../../ipc/gateway-client.js", () => ({
  ipcCall: async (route: string) => {
    ipcCalls.push(route);
    return {};
  },
}));

let guardianDeliveryReads = 0;
mock.module("../../../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => {
    guardianDeliveryReads++;
    return [];
  },
  getGuardianDeliveryFresh: async () => {
    guardianDeliveryReads++;
    return [];
  },
  peekCachedGuardianDelivery: () => {
    guardianDeliveryReads++;
    return undefined;
  },
  guardianForChannel: () => undefined,
  anyGuardian: () => undefined,
}));

let setMemberVerdictCalls = 0;
mock.module("../../member-verdict-cache.js", () => ({
  setMemberVerdict: () => {
    setMemberVerdictCalls++;
  },
  getCachedMemberAcl: () => undefined,
  __resetMemberVerdictCacheForTest: () => {},
}));

// Local contact store must not be consulted — verdict-only classification.
let contactLookups = 0;
mock.module("../../../contacts/contact-store.js", () => ({
  findContactByAddress: () => {
    contactLookups++;
    return null;
  },
}));

// ---------------------------------------------------------------------------
// Downstream side-effect stubs
// ---------------------------------------------------------------------------

let recordInboundCalls: Array<{ conversationId?: string }> = [];
// Keyed the way the real `channel_inbound_events` row is keyed, so a test can
// replay a sequence of events and see which of them the daemon treats as new.
const inboundStore = new Map<
  string,
  { eventId: string; conversationId: string }
>();
const inboundKey = (channel: string, chat: string, id: string) =>
  `${channel}\u0000${chat}\u0000${id}`;
/** Seed a row so the next delivery of `externalMessageId` reads as a redelivery. */
function seedRecordedEvent(externalMessageId: string, eventId: string): void {
  inboundStore.set(inboundKey("slack", SLACK_CHANNEL_ID, externalMessageId), {
    eventId,
    conversationId: "conv-target",
  });
}
let outboundTargetConversationId: string | null = null;
let outboundLookupChannels: string[] = [];
let storedTarget: { messageId: string; conversationId: string } | null = null;
mock.module("../../../persistence/delivery-crud.js", () => ({
  recordInbound: (
    channel: string,
    chat: string,
    externalMessageId: string,
    options?: { conversationId?: string },
  ) => {
    recordInboundCalls.push({ conversationId: options?.conversationId });
    const key = inboundKey(channel, chat, externalMessageId);
    const existing = inboundStore.get(key);
    if (existing) {
      return { ...existing, accepted: true, duplicate: true };
    }
    const row = {
      eventId: `evt-${inboundStore.size + 1}`,
      conversationId: options?.conversationId ?? "conv-minted",
    };
    inboundStore.set(key, row);
    return { ...row, accepted: true, duplicate: false };
  },
  findMessageBySourceId: () => storedTarget,
  findMessageByProviderMessageId: (sourceChannel: string) => {
    outboundLookupChannels.push(sourceChannel);
    return outboundTargetConversationId
      ? {
          messageId: "outbound-row-1",
          conversationId: outboundTargetConversationId,
        }
      : null;
  },
  findInboundEvent: (
    channel: string,
    chat: string,
    externalMessageId: string,
  ) => inboundStore.get(inboundKey(channel, chat, externalMessageId)) ?? null,
  clearPayload: () => {},
  storePayload: (eventId: string, payload: Record<string, unknown>) => {
    storedPayloads.push({ eventId, payload });
  },
  linkMessage: () => {},
}));
const storedPayloads: Array<{
  eventId: string;
  payload: Record<string, unknown>;
}> = [];

let addMessageCalls = 0;
let targetRow: {
  role: string;
  content: unknown;
  metadata?: string | null;
} | null = null;
mock.module("../../../persistence/conversation-crud.js", () => ({
  addMessage: async () => {
    addMessageCalls++;
    return { id: "msg-1" };
  },
  getMessageById: () => targetRow,
}));

let markProcessedCalls = 0;
mock.module("../../../persistence/delivery-status.js", () => ({
  markProcessed: () => {
    markProcessedCalls++;
  },
}));

let dispatchedTurns: Array<Record<string, unknown>> = [];
let dispatchThrows = false;
mock.module("./background-dispatch.js", () => ({
  processChannelMessageInBackground: (params: Record<string, unknown>) => {
    if (dispatchThrows) {
      throw new Error("dispatch setup exploded");
    }
    dispatchedTurns.push(params);
  },
}));

// The intercept imports `processMessage` only to hand it to the dispatch;
// stub it so the test never drags the daemon turn machinery in at import
// time.
mock.module("../../../daemon/process-message.js", () => ({
  processMessage: async () => ({ messageId: "turn-user-row" }),
}));
mock.module("../../../daemon/approval-generators.js", () => ({
  createApprovalCopyGenerator: () => ({}),
}));
mock.module("../../../persistence/external-conversation-store.js", () => ({
  upsertBinding: () => {},
}));
mock.module("../../../daemon/disk-pressure-guard.js", () => ({
  getDiskPressureStatus: () => ({ level: "ok" }),
}));
mock.module("../../../daemon/disk-pressure-policy.js", () => ({
  classifyDiskPressureTurnPolicy: () => ({ action: "allow" }),
}));

import { handleReactionIntercept } from "./reaction-intercept.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GUARDIAN_VERDICT: TrustVerdict = {
  trustClass: "guardian",
  canonicalSenderId: GUARDIAN_USER_ID,
  contactId: "guardian-contact",
  channelId: "guardian-channel",
  type: "slack",
  address: GUARDIAN_USER_ID,
  status: "active",
  policy: "allow",
  guardianExternalUserId: GUARDIAN_USER_ID,
  guardianDeliveryChatId: SLACK_CHANNEL_ID,
  guardianPrincipalId: "principal-guardian-1",
};

const MEMBER_VERDICT: TrustVerdict = {
  trustClass: "trusted_contact",
  canonicalSenderId: MEMBER_USER_ID,
  contactId: "member-contact",
  channelId: "member-channel",
  type: "slack",
  address: MEMBER_USER_ID,
  status: "active",
  policy: "allow",
};

const UNKNOWN_VERDICT: TrustVerdict = {
  trustClass: "unknown",
  canonicalSenderId: "U_STRANGER",
};

let msgCounter = 0;

function buildParams(overrides: {
  rawSenderId: string;
  trustVerdict?: TrustVerdict;
  op?: "added" | "removed";
  externalMessageId?: string;
  sourceChannel?: "slack" | "discord";
}) {
  msgCounter++;
  const sourceChannel = overrides.sourceChannel ?? ("slack" as const);
  return {
    reaction: {
      op: overrides.op ?? ("added" as const),
      emoji: "white_check_mark",
      emojiKind: "shortcode" as const,
      emojiName: "white_check_mark",
      targetMessageId: "1700000000.1",
    },
    sourceChannel,
    sourceInterface: sourceChannel,
    conversationExternalId: SLACK_CHANNEL_ID,
    externalMessageId:
      overrides.externalMessageId ??
      `${SLACK_CHANNEL_ID}:1700000000.1:${msgCounter}`,
    rawSenderId: overrides.rawSenderId,
    canonicalSenderId: overrides.rawSenderId,
    actorDisplayName: "Reactor",
    actorUsername: undefined,
    // The shape the gateway actually builds for a reaction: the reacted
    // message's own ts stands in as `threadTs`, which is what the wake has
    // to correct before delivering a reply.
    replyCallbackUrl: `http://localhost:7830/deliver/slack?channel=${SLACK_CHANNEL_ID}&threadTs=1700000000.1`,
    sourceMetadata: {
      messageId: "1700000000.1",
      chatType: "channel",
      ...(overrides.trustVerdict
        ? { trustVerdict: overrides.trustVerdict }
        : {}),
    } as never,
  };
}

function expectDropped(result: Record<string, unknown>): void {
  expect(result.reaction).toBe("dropped_unknown_actor");
  // Dropped before any write: no dedup record and no transcript row.
  expect(recordInboundCalls.length).toBe(0);
  expect(addMessageCalls).toBe(0);
}

function resetHarness(): void {
  ipcCalls = [];
  guardianDeliveryReads = 0;
  setMemberVerdictCalls = 0;
  contactLookups = 0;
  recordInboundCalls = [];
  inboundStore.clear();
  outboundTargetConversationId = null;
  outboundLookupChannels = [];
  addMessageCalls = 0;
  storedTarget = { messageId: "msg-target", conversationId: "conv-target" };
  // Default target: a user-authored row, so reactions stay passive unless
  // a test makes the target the assistant's own post.
  targetRow = {
    role: "user",
    content: [{ type: "text", text: "the reacted-to message" }],
  };
  dispatchedTurns = [];
  dispatchThrows = false;
  storedPayloads.length = 0;
  markProcessedCalls = 0;
}

describe("reaction intercept consumes the stamped verdict directly", () => {
  beforeEach(resetHarness);

  test("a guardian's reaction is a transcript row, not an approval decision", async () => {
    const result = await handleReactionIntercept(
      buildParams({
        rawSenderId: GUARDIAN_USER_ID,
        trustVerdict: GUARDIAN_VERDICT,
      }),
    );

    // A guardian reacts like any other admitted actor: the emoji annotates
    // the room. Approvals are answered by the card's buttons.
    expect(result.accepted).toBe(true);
    expect(result.reaction).toBeUndefined();
    expect(addMessageCalls).toBe(1);
    expect(recordInboundCalls).toEqual([{ conversationId: "conv-target" }]);
  });

  test("a contact's reaction is recorded in the reacted message's conversation", async () => {
    const result = await handleReactionIntercept(
      buildParams({
        rawSenderId: MEMBER_USER_ID,
        trustVerdict: MEMBER_VERDICT,
      }),
    );

    expect(result.accepted).toBe(true);
    expect(result.reaction).toBeUndefined();
    expect(addMessageCalls).toBe(1);
    // Recorded into the reacted message's conversation, never a fresh one.
    expect(recordInboundCalls).toEqual([{ conversationId: "conv-target" }]);
  });

  test("a reaction added to the assistant's own post wakes a discretion turn", async () => {
    // Outbound posts open no inbound event, so the id is only on the row.
    storedTarget = null;
    outboundTargetConversationId = "conv-assistant-post";
    targetRow = {
      role: "assistant",
      content: [{ type: "text", text: "Deploy finished cleanly." }],
    };

    const result = await handleReactionIntercept(
      buildParams({
        rawSenderId: MEMBER_USER_ID,
        trustVerdict: MEMBER_VERDICT,
      }),
    );

    expect(recordInboundCalls).toEqual([
      { conversationId: "conv-assistant-post" },
    ]);
    // The outbound-row lookup is scoped to the reaction's own channel: a
    // Slack reaction never scans another channel's conversations.
    expect(outboundLookupChannels).toEqual(["slack"]);
    expect(result).toMatchObject({
      accepted: true,
      duplicate: false,
      reaction: "wake_dispatched",
    });
    // The turn's own persisted row is the reaction row: no passive write,
    // and the event is settled up front (wake turns opt out of sweep replay).
    expect(addMessageCalls).toBe(0);
    expect(markProcessedCalls).toBe(1);
    expect(dispatchedTurns).toHaveLength(1);
    const turn = dispatchedTurns[0];
    expect(turn.conversationId).toBe("conv-assistant-post");
    expect(turn.clientMessageId).toBe("reaction:evt-1");
    expect(turn.skipUserMessageIndexing).toBe(true);
    // The model's turn content is the same line the reload renderer
    // produces, with the quoted target resolved.
    expect(String(turn.content)).toContain("reacted with");
    expect(String(turn.content)).toContain("Deploy finished cleanly.");
    // The row's envelope matches what the passive path would have written,
    // riding the transitional Slack-only carrier.
    expect(typeof turn.slackReactionRowMeta).toBe("string");
    expect(turn.channelInbound).toBeUndefined();
  });

  test("a non-Slack reaction on the assistant's post wakes with the neutral envelope", async () => {
    storedTarget = null;
    outboundTargetConversationId = "conv-discord-post";
    targetRow = {
      role: "assistant",
      content: [{ type: "text", text: "Deploy finished cleanly." }],
    };

    const params = {
      ...buildParams({
        rawSenderId: MEMBER_USER_ID,
        trustVerdict: MEMBER_VERDICT,
      }),
      sourceChannel: "discord" as const,
      sourceInterface: "discord" as const,
    };
    const result = await handleReactionIntercept(params);

    expect(outboundLookupChannels).toEqual(["discord"]);
    expect(result).toMatchObject({
      accepted: true,
      duplicate: false,
      reaction: "wake_dispatched",
    });
    expect(dispatchedTurns).toHaveLength(1);
    // Non-Slack wake turns ride the ordinary neutral-envelope carrier, the
    // same lane inbound messages use.
    const channelInbound = dispatchedTurns[0].channelInbound as Record<
      string,
      unknown
    >;
    expect(channelInbound.eventKind).toBe("reaction");
    expect(channelInbound.source).toBe("discord");
    expect(dispatchedTurns[0].slackReactionRowMeta).toBeUndefined();
  });

  test("a Slack wake reply targets the thread the reacted message lives in", async () => {
    // The reaction event's callback names the REACTED MESSAGE's ts as its
    // thread (Slack gives a reaction no thread of its own), so delivering
    // through it unchanged would root the reply at that message instead of
    // in the conversation's own thread.
    storedTarget = null;
    outboundTargetConversationId = "conv-assistant-post";
    targetRow = {
      role: "assistant",
      content: [{ type: "text", text: "Deploy finished cleanly." }],
      metadata: JSON.stringify({
        slackMeta: JSON.stringify({
          source: "slack",
          channelId: SLACK_CHANNEL_ID,
          channelTs: "1700000000.1",
          threadTs: "1699999999.9",
          eventKind: "message",
        }),
      }),
    };

    await handleReactionIntercept(
      buildParams({
        rawSenderId: MEMBER_USER_ID,
        trustVerdict: MEMBER_VERDICT,
      }),
    );

    const url = new URL(dispatchedTurns[0].replyCallbackUrl as string);
    // Replaced, not merely present: the event arrived naming 1700000000.1.
    expect(url.searchParams.get("threadTs")).toBe("1699999999.9");
    expect(url.searchParams.get("channel")).toBe(SLACK_CHANNEL_ID);
    // The stored delivery payload names the same corrected destination.
    expect(
      new URL(
        storedPayloads[0].payload.replyCallbackUrl as string,
      ).searchParams.get("threadTs"),
    ).toBe("1699999999.9");
  });

  test("a Slack wake reply on a channel-root post carries no thread", async () => {
    storedTarget = null;
    outboundTargetConversationId = "conv-assistant-post";
    targetRow = {
      role: "assistant",
      content: [{ type: "text", text: "Deploy finished cleanly." }],
      metadata: JSON.stringify({
        slackMeta: JSON.stringify({
          source: "slack",
          channelId: SLACK_CHANNEL_ID,
          channelTs: "1700000000.1",
          eventKind: "message",
        }),
      }),
    };

    await handleReactionIntercept(
      buildParams({
        rawSenderId: MEMBER_USER_ID,
        trustVerdict: MEMBER_VERDICT,
      }),
    );

    const url = new URL(dispatchedTurns[0].replyCallbackUrl as string);
    // The target sits at the channel root, so the reply belongs there too,
    // never in a thread rooted at the reacted message.
    expect(url.searchParams.get("threadTs")).toBeNull();
    expect(url.searchParams.get("channel")).toBe(SLACK_CHANNEL_ID);
  });

  test("the wake stores a delivery-only payload, never a replayable turn", async () => {
    storedTarget = null;
    outboundTargetConversationId = "conv-assistant-post";
    targetRow = {
      role: "assistant",
      content: [{ type: "text", text: "Deploy finished cleanly." }],
    };

    await handleReactionIntercept(
      buildParams({
        rawSenderId: MEMBER_USER_ID,
        trustVerdict: MEMBER_VERDICT,
      }),
    );

    expect(storedPayloads).toHaveLength(1);
    const payload = storedPayloads[0].payload;
    // Enough for the delivery lane to re-post a generated reply...
    expect(typeof payload.replyCallbackUrl).toBe("string");
    expect(payload.externalChatId).toBe(SLACK_CHANNEL_ID);
    // ...and structurally incapable of being replayed as a message turn.
    expect(payload.content).toBeUndefined();
    expect(payload.sourceChannel).toBeUndefined();
  });

  test("a wake whose dispatch fails to start still records the passive row", async () => {
    storedTarget = null;
    outboundTargetConversationId = "conv-assistant-post";
    targetRow = {
      role: "assistant",
      content: [{ type: "text", text: "Deploy finished cleanly." }],
    };
    dispatchThrows = true;

    const result = await handleReactionIntercept(
      buildParams({
        rawSenderId: MEMBER_USER_ID,
        trustVerdict: MEMBER_VERDICT,
      }),
    );

    // The dedup record already exists, so a gateway retry would short-circuit;
    // the reaction must not vanish because the turn could not start.
    expect(addMessageCalls).toBe(1);
    expect(result.reaction).toBeUndefined();
    expect(result).toMatchObject({ accepted: true });
  });

  test("a reaction REMOVED from the assistant's post stays passive", async () => {
    storedTarget = null;
    outboundTargetConversationId = "conv-assistant-post";
    targetRow = {
      role: "assistant",
      content: [{ type: "text", text: "Deploy finished cleanly." }],
    };

    const result = await handleReactionIntercept(
      buildParams({
        rawSenderId: MEMBER_USER_ID,
        trustVerdict: MEMBER_VERDICT,
        op: "removed",
      }),
    );

    expect(dispatchedTurns).toHaveLength(0);
    expect(addMessageCalls).toBe(1);
    expect(result.reaction).toBeUndefined();
  });

  test("losing the lock after admission degrades the wake to the passive row", async () => {
    storedTarget = null;
    outboundTargetConversationId = "conv-assistant-post";
    targetRow = {
      role: "assistant",
      content: [{ type: "text", text: "Deploy finished cleanly." }],
    };

    await handleReactionIntercept(
      buildParams({
        rawSenderId: MEMBER_USER_ID,
        trustVerdict: MEMBER_VERDICT,
      }),
    );
    expect(addMessageCalls).toBe(0);
    const fallback = dispatchedTurns[0].onTurnLostToBusy as () => Promise<void>;
    await fallback();
    // Exactly the row the passive path would have written.
    expect(addMessageCalls).toBe(1);
  });

  test("a reaction on a message that is not stored is dropped without minting", async () => {
    storedTarget = null;

    const result = await handleReactionIntercept(
      buildParams({
        rawSenderId: MEMBER_USER_ID,
        trustVerdict: MEMBER_VERDICT,
      }),
    );

    expect(result.reaction).toBe("dropped_unknown_target");
    expect(recordInboundCalls.length).toBe(0);
    expect(addMessageCalls).toBe(0);
  });

  test("a reaction on a guardian card neither records nor wakes", async () => {
    // A legacy channel delivery paired a message row before cards became
    // projection-only, so such rows are still stored. The row is
    // assistant-authored, so without the guardian-card gate the wake
    // predicate would read a reaction on it as a signal addressed to the
    // assistant. Content is shaped the way `isGuardianCardRow` reads it.
    targetRow = {
      role: "assistant",
      content: [
        {
          type: "ui_surface",
          surfaceId: "tool-approval-req-legacy-1",
        },
      ],
    };

    const result = await handleReactionIntercept(
      buildParams({
        rawSenderId: GUARDIAN_USER_ID,
        trustVerdict: GUARDIAN_VERDICT,
      }),
    );

    expect(result.reaction).toBe("dropped_guardian_card");
    expect(dispatchedTurns.length).toBe(0);
    expect(recordInboundCalls.length).toBe(0);
    expect(addMessageCalls).toBe(0);
  });

  test("a redelivered reaction is answered once, before any lookup", async () => {
    const externalMessageId = `${SLACK_CHANNEL_ID}:1700000000.1:redelivered`;
    seedRecordedEvent(externalMessageId, "evt-1");

    const result = await handleReactionIntercept(
      buildParams({
        rawSenderId: GUARDIAN_USER_ID,
        trustVerdict: GUARDIAN_VERDICT,
        externalMessageId,
      }),
    );

    expect(result).toEqual({
      accepted: true,
      duplicate: true,
      eventId: "evt-1",
    });
    expect(addMessageCalls).toBe(0);
    expect(recordInboundCalls.length).toBe(0);
  });

  test("unknown verdict is dropped before any write", async () => {
    const result = await handleReactionIntercept(
      buildParams({ rawSenderId: "U_STRANGER", trustVerdict: UNKNOWN_VERDICT }),
    );
    expectDropped(result);
  });

  test("missing verdict is dropped fail-closed", async () => {
    const result = await handleReactionIntercept(
      buildParams({ rawSenderId: MEMBER_USER_ID }),
    );
    expectDropped(result);
  });

  test("resolutionFailed verdict is dropped fail-closed even with a guardian shape", async () => {
    const result = await handleReactionIntercept(
      buildParams({
        rawSenderId: GUARDIAN_USER_ID,
        trustVerdict: { ...GUARDIAN_VERDICT, resolutionFailed: true },
      }),
    );
    expectDropped(result);
  });

  test("memberless guardian verdict is contradictory and dropped fail-closed", async () => {
    const result = await handleReactionIntercept(
      buildParams({
        rawSenderId: GUARDIAN_USER_ID,
        trustVerdict: {
          trustClass: "guardian",
          canonicalSenderId: GUARDIAN_USER_ID,
          guardianPrincipalId: "principal-guardian-1",
        },
      }),
    );
    expectDropped(result);
  });

  test("classification is verdict-only: no IPC, cache, or local-store reads", async () => {
    await handleReactionIntercept(
      buildParams({
        rawSenderId: GUARDIAN_USER_ID,
        trustVerdict: GUARDIAN_VERDICT,
      }),
    );
    await handleReactionIntercept(
      buildParams({
        rawSenderId: MEMBER_USER_ID,
        trustVerdict: MEMBER_VERDICT,
      }),
    );

    expect(ipcCalls).toEqual([]);
    expect(guardianDeliveryReads).toBe(0);
    expect(setMemberVerdictCalls).toBe(0);
    expect(contactLookups).toBe(0);
  });
});

/**
 * Add, remove, re-add: the sequence whose third event must survive dedup.
 *
 * The intercept returns before `persistPassively` on a duplicate, so an id
 * that repeats across occurrences costs the re-add its transcript row and
 * leaves the removal as the last recorded state. The ids here are the shapes
 * the gateway normalizers build (`slack/reaction-normalizer.ts`,
 * `discord/normalize.ts`), whose per-event component is the trailing segment.
 */
describe("a re-added reaction records again", () => {
  const SLACK_IDS = [
    `${SLACK_CHANNEL_ID}:1700000000.1:white_check_mark:${MEMBER_USER_ID}:Ev001`,
    `${SLACK_CHANNEL_ID}:1700000000.1:white_check_mark:${MEMBER_USER_ID}:removed:Ev002`,
    `${SLACK_CHANNEL_ID}:1700000000.1:white_check_mark:${MEMBER_USER_ID}:Ev003`,
  ];
  const DISCORD_IDS = [
    `1700000000.1:reaction:\u2705:${MEMBER_USER_ID}:dispatch-0`,
    `1700000000.1:reaction:\u2705:${MEMBER_USER_ID}:removed:dispatch-1`,
    `1700000000.1:reaction:\u2705:${MEMBER_USER_ID}:dispatch-2`,
  ];

  beforeEach(resetHarness);

  async function replay(
    externalMessageIds: string[],
    ops: Array<"added" | "removed">,
    sourceChannel: "slack" | "discord" = "slack",
  ) {
    const results: Array<Record<string, unknown>> = [];
    for (const [index, externalMessageId] of externalMessageIds.entries()) {
      results.push(
        await handleReactionIntercept(
          buildParams({
            rawSenderId: MEMBER_USER_ID,
            trustVerdict: MEMBER_VERDICT,
            op: ops[index],
            externalMessageId,
            sourceChannel,
          }),
        ),
      );
    }
    return results;
  }

  test("Slack: three events, three transcript rows, none deduped away", async () => {
    const results = await replay(SLACK_IDS, ["added", "removed", "added"]);

    expect(results.map((result) => result.duplicate)).toEqual([
      false,
      false,
      false,
    ]);
    expect(inboundStore.size).toBe(3);
    expect(addMessageCalls).toBe(3);
  });

  test("Discord: three events, three transcript rows, none deduped away", async () => {
    const results = await replay(
      DISCORD_IDS,
      ["added", "removed", "added"],
      "discord",
    );

    expect(results.map((result) => result.duplicate)).toEqual([
      false,
      false,
      false,
    ]);
    expect(inboundStore.size).toBe(3);
    expect(addMessageCalls).toBe(3);
  });

  test("a genuine redelivery of one event still collapses to one", async () => {
    // What the dedup id is for: the gateway retries a forward with the same
    // payload, so the same id arrives twice and the second writes nothing.
    const [first, second] = await replay(
      [SLACK_IDS[0]!, SLACK_IDS[0]!],
      ["added", "added"],
    );

    expect(first!.duplicate).toBe(false);
    expect(second!.duplicate).toBe(true);
    expect(second!.eventId).toBe(first!.eventId);
    expect(inboundStore.size).toBe(1);
    expect(addMessageCalls).toBe(1);
  });
});
