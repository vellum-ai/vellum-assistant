import { describe, expect, test } from "bun:test";

import type { MessageRow } from "../../memory/conversation-crud.js";
import { selectTriggeringMessageFacts } from "../tool-approval-source.js";

/**
 * Pins the pure triggering-message selection: actor-matched attribution, the
 * fallback to the most recent message, Slack-metadata projection, and graceful
 * emptiness. The store read is a thin wrapper exercised by integration paths.
 */
function userMessage(opts: {
  content: string;
  createdAt: number;
  slack?: {
    channelId: string;
    channelTs: string;
    channelName?: string;
    displayName?: string;
    actorExternalUserId?: string;
  };
}): MessageRow {
  const metadata = opts.slack
    ? JSON.stringify({
        slackMeta: JSON.stringify({
          source: "slack",
          eventKind: "message",
          ...opts.slack,
        }),
      })
    : null;
  return {
    id: `m-${opts.createdAt}`,
    conversationId: "c1",
    role: "user",
    content: opts.content,
    createdAt: opts.createdAt,
    metadata,
    clientMessageId: null,
  };
}

describe("selectTriggeringMessageFacts", () => {
  test("returns empty facts when there are no messages", () => {
    expect(selectTriggeringMessageFacts([])).toEqual({});
  });

  test("prefers the escalating actor's own message over a newer one", () => {
    // newest first
    const messages = [
      userMessage({
        content: "later message from someone else",
        createdAt: 200,
        slack: {
          channelId: "C01",
          channelTs: "200.0001",
          actorExternalUserId: "UOTHER",
        },
      }),
      userMessage({
        content: "the contact's request",
        createdAt: 100,
        slack: {
          channelId: "C01",
          channelTs: "100.0002",
          channelName: "general",
          displayName: "Noa",
          actorExternalUserId: "UNOA",
        },
      }),
    ];
    expect(selectTriggeringMessageFacts(messages, "UNOA")).toEqual({
      messagePreview: "the contact's request",
      conversationExternalId: "C01",
      messageTs: "100.0002",
      channelName: "general",
      actorDisplayName: "Noa",
    });
  });

  test("falls back to the most recent message when no actor match", () => {
    const messages = [
      userMessage({
        content: "newest",
        createdAt: 200,
        slack: {
          channelId: "C01",
          channelTs: "200.0001",
          displayName: "Sam",
          actorExternalUserId: "USAM",
        },
      }),
    ];
    expect(selectTriggeringMessageFacts(messages, "UNOMATCH")).toMatchObject({
      messagePreview: "newest",
      messageTs: "200.0001",
      actorDisplayName: "Sam",
    });
  });

  test("non-slack message yields preview text only (no channel/ts)", () => {
    const messages = [
      userMessage({ content: "search the news", createdAt: 5 }),
    ];
    const facts = selectTriggeringMessageFacts(messages, "U1");
    expect(facts.messagePreview).toBe("search the news");
    expect(facts.conversationExternalId).toBeUndefined();
    expect(facts.messageTs).toBeUndefined();
  });
});
