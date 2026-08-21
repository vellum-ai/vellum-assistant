import { describe, expect, test } from "bun:test";

import {
  slackChannelChatType,
  slackConversationType,
} from "../slack/message-normalizer.js";
import { telegramConversationType } from "../telegram/normalize.js";

/**
 * The permission matrix's conversation-type axis, mapped by each channel that
 * can answer it. There is no shared mapper any more: only the sending channel
 * knows what its own surfaces mean, so the axis is asserted per channel and
 * swept across all of them here.
 */
describe("conversation type, per channel", () => {
  test("every DM-capable channel's own word for a DM lands on the axis", () => {
    // A missing arm is silent rather than loud: the permission cell stays
    // settable, because the adapter validates against the channel registry, and
    // simply never matches. The guardian sets a rule for DMs on that channel
    // and it does nothing. Stated as a sweep so a DM-capable channel added
    // without its mapping fails here rather than in someone's workspace.
    const dmByChannel: Record<string, string | undefined> = {
      slack: slackConversationType("im"),
      telegram: telegramConversationType("private"),
    };
    for (const [channel, resolved] of Object.entries(dmByChannel)) {
      expect(`${channel}:${resolved}`).toBe(`${channel}:dm`);
    }
  });

  test("Slack tells a public room from a private one", () => {
    // The change this file exists for. `channel` used to mean every non-DM, so
    // it could not be mapped at all and the public tier never matched. Slack
    // names a private channel `group`, and the normalizer now forwards that,
    // so both tiers resolve.
    expect(slackConversationType("channel")).toBe("public");
    expect(slackConversationType("group")).toBe("private");
    expect(slackConversationType("mpim")).toBe("private");
  });

  test("Telegram closed groups are private, and a broadcast is neither", () => {
    expect(telegramConversationType("group")).toBe("private");
    expect(telegramConversationType("supergroup")).toBe("private");
    // A Telegram `channel` is a broadcast feed, not a room. Calling it public
    // would let a rule written for conversational rooms govern a surface that
    // is not a conversation.
    expect(telegramConversationType("channel")).toBeUndefined();
  });

  test("an unknown or absent surface is never reported public", () => {
    // The safe direction. Absent means nobody proved the visibility, and a
    // permissive public cell must not reach a room on a guess.
    for (const value of [undefined, "", "wat"]) {
      expect(slackConversationType(value as never)).toBeUndefined();
      expect(telegramConversationType(value)).toBeUndefined();
    }
  });
});

describe("slackChannelChatType, the uncertain direction", () => {
  test("an explicit type is authoritative in both directions", () => {
    expect(slackChannelChatType("C123", "channel")).toBe("channel");
    expect(slackChannelChatType("G123", "group")).toBe("group");
    // The explicit type wins over the prefix rather than being second-guessed.
    expect(slackChannelChatType("G123", "channel")).toBe("channel");
  });

  test("a private channel with no type is still private", () => {
    // Slack omits `channel_type` on thread replies, edits and deletes. Without
    // the prefix fallback, a threaded message in a private channel would report
    // as public and a permissive public rule would reach a private room. This
    // is the assertion that fails if the fallback is ever simplified away.
    expect(slackChannelChatType("G0PRIVATE", undefined)).toBe("group");
  });

  test("a public channel with no type reads public", () => {
    expect(slackChannelChatType("C0PUBLIC", undefined)).toBe("channel");
  });

  test("no signal at all does not invent a private room", () => {
    // Nothing to go on resolves to `channel`, which `slackConversationType`
    // then maps to `public`. That is only sound because multi-person IMs reach
    // their own normalizer and never this path.
    expect(slackChannelChatType(undefined, undefined)).toBe("channel");
  });
});
