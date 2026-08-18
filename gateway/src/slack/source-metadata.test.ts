import { describe, expect, it } from "bun:test";

import type { NormalizedSlackEvent } from "./message-schemas.js";
import { buildSlackSourceMetadata } from "./source-metadata.js";

const CHANNEL = "C0123CHANNEL";
const MESSAGE_TS = "1700000000.000100";

function normalized(overrides: {
  rawType?: string;
  threadTs?: string;
  sourceThreadId?: string;
  isEdit?: boolean;
  callbackData?: string;
}): NormalizedSlackEvent {
  return {
    event: {
      version: "v1",
      sourceChannel: "slack",
      receivedAt: new Date().toISOString(),
      message: {
        content: "hello",
        conversationExternalId: CHANNEL,
        externalMessageId: MESSAGE_TS,
        ...(overrides.isEdit ? { isEdit: true } : {}),
        ...(overrides.callbackData
          ? { callbackData: overrides.callbackData }
          : {}),
      },
      actor: { actorExternalId: "U0123" },
      source: {
        updateId: "Ev123",
        messageId: MESSAGE_TS,
        ...(overrides.sourceThreadId
          ? { threadId: overrides.sourceThreadId }
          : {}),
      },
      raw: { type: overrides.rawType ?? "message" },
    },
    routing: { assistantId: "self" } as NormalizedSlackEvent["routing"],
    ...(overrides.threadTs ? { threadTs: overrides.threadTs } : {}),
    channel: CHANNEL,
  } as NormalizedSlackEvent;
}

describe("buildSlackSourceMetadata", () => {
  it("gives a message with no thread of its own the thread its reply will create", () => {
    // The assistant replies in a thread rooted here, so keying the
    // conversation on it is correct.
    expect(
      buildSlackSourceMetadata(normalized({ threadTs: MESSAGE_TS })),
    ).toEqual({ threadId: MESSAGE_TS });
  });

  it("passes through a real thread the message is already in", () => {
    const meta = buildSlackSourceMetadata(
      normalized({
        threadTs: "1699999999.000001",
        sourceThreadId: "1699999999.000001",
      }),
    );
    // Already on `source.threadId`, so nothing is added here.
    expect(meta.threadId).toBeUndefined();
  });

  it("gives an edit no thread id, so it cannot key a conversation on one", () => {
    expect(
      buildSlackSourceMetadata(
        normalized({ threadTs: MESSAGE_TS, isEdit: true }),
      ),
    ).toEqual({});
  });

  it("gives a button press no thread id", () => {
    expect(
      buildSlackSourceMetadata(
        normalized({
          threadTs: MESSAGE_TS,
          callbackData: "apr:req-1:approve_once",
        }),
      ),
    ).toEqual({});
  });

  it("keeps a real thread on an edit made inside one", () => {
    // `source.threadId` is Slack's own answer, not a fallback, so it survives.
    const meta = buildSlackSourceMetadata(
      normalized({
        threadTs: "1699999999.000001",
        sourceThreadId: "1699999999.000001",
        isEdit: true,
      }),
    );
    expect(meta.threadId).toBeUndefined();
  });

  it("marks an app mention", () => {
    expect(
      buildSlackSourceMetadata(
        normalized({ rawType: "app_mention", threadTs: MESSAGE_TS }),
      ),
    ).toEqual({ slackBotMentioned: true, threadId: MESSAGE_TS });
  });
});
