import { describe, it, expect } from "bun:test";

import { slackEventOrderingKey } from "./event-ordering.js";
import type {
  SlackAppMentionEvent,
  SlackMessageChangedEvent,
  SlackMessageDeletedEvent,
  SlackReactionEvent,
} from "./normalize.js";

const CHANNEL = "C0ABCDEF";
const TS = "1700000000.000100";
const EVENT_ID = "Ev0MALFORMED";

describe("slackEventOrderingKey — well-formed events", () => {
  it("keys a reaction on its item channel + ts", () => {
    const event = {
      type: "reaction_added",
      user: "U1",
      reaction: "thumbsup",
      item: { type: "message", channel: CHANNEL, ts: TS },
    } as SlackReactionEvent;
    expect(slackEventOrderingKey(event, EVENT_ID)).toBe(`${CHANNEL}:${TS}`);
  });

  it("keys a reaction_removed the same as reaction_added (same lane)", () => {
    const event = {
      type: "reaction_removed",
      user: "U1",
      reaction: "thumbsup",
      item: { type: "message", channel: CHANNEL, ts: TS },
    } as SlackReactionEvent;
    expect(slackEventOrderingKey(event, EVENT_ID)).toBe(`${CHANNEL}:${TS}`);
  });

  it("keys a message_changed on its channel + edited message thread_ts", () => {
    const event = {
      type: "message",
      subtype: "message_changed",
      channel: CHANNEL,
      ts: TS,
      message: { text: "edited", ts: "1700000000.000200", thread_ts: TS },
    } as SlackMessageChangedEvent;
    expect(slackEventOrderingKey(event, EVENT_ID)).toBe(`${CHANNEL}:${TS}`);
  });

  it("keys a message_delete on its channel + previous_message thread_ts", () => {
    const event = {
      type: "message",
      subtype: "message_deleted",
      channel: CHANNEL,
      deleted_ts: TS,
      previous_message: { text: "gone", ts: TS, thread_ts: TS },
    } as SlackMessageDeletedEvent;
    expect(slackEventOrderingKey(event, EVENT_ID)).toBe(`${CHANNEL}:${TS}`);
  });

  it("keys a plain message on channel + thread_ts (falling back to ts)", () => {
    const event = {
      type: "app_mention",
      channel: CHANNEL,
      user: "U1",
      text: "hi",
      ts: TS,
    } as SlackAppMentionEvent;
    expect(slackEventOrderingKey(event, EVENT_ID)).toBe(`${CHANNEL}:${TS}`);
  });
});

describe("slackEventOrderingKey — malformed events do not crash the emit path", () => {
  it("does not throw when a reaction is missing `item`, falling back to eventId", () => {
    // `item` is untrusted and can be absent; dereferencing `item.channel` here
    // (before normalization) would throw and take down the ordering lane.
    const event = {
      type: "reaction_added",
      user: "U1",
      reaction: "thumbsup",
    } as unknown as SlackReactionEvent;
    expect(() => slackEventOrderingKey(event, EVENT_ID)).not.toThrow();
    expect(slackEventOrderingKey(event, EVENT_ID)).toBe(
      `${EVENT_ID}:${EVENT_ID}`,
    );
  });

  it("does not throw when a message_changed is missing `message`, falling back to eventId", () => {
    // A `message_changed` in a subscribed channel is admitted without requiring
    // `message`, so `message.thread_ts` here would throw on the hot path.
    const event = {
      type: "message",
      subtype: "message_changed",
      channel: CHANNEL,
      ts: TS,
    } as unknown as SlackMessageChangedEvent;
    expect(() => slackEventOrderingKey(event, EVENT_ID)).not.toThrow();
    expect(slackEventOrderingKey(event, EVENT_ID)).toBe(
      `${CHANNEL}:${EVENT_ID}`,
    );
  });
});
