import { describe, expect, test } from "bun:test";

import { slackConversationVisibility } from "../slack/message-normalizer.js";
import { telegramConversationType } from "../telegram/normalize.js";
import { pluginConversationType } from "./plugin-inbound.js";

/**
 * The permission matrix's conversation-type axis, answered by each channel that
 * can answer it. There is no shared mapper: only the sending channel knows what
 * its own surfaces mean, so the axis is asserted per channel and swept across
 * all of them here.
 */
describe("conversation type, per channel", () => {
  test("every DM-capable channel's own word for a DM lands on the axis", () => {
    // A missing arm is silent rather than loud: the permission cell stays
    // settable, because the adapter validates against the channel registry, and
    // simply never matches. The guardian sets a rule for DMs on that channel
    // and it does nothing. Stated as a sweep so a DM-capable channel added
    // without its mapping fails here rather than in someone's workspace.
    const dmByChannel: Record<string, string | undefined> = {
      slack: slackConversationVisibility("D0DIRECT", "im"),
      telegram: telegramConversationType("private"),
      plugin: pluginConversationType("dm"),
    };
    for (const [channel, resolved] of Object.entries(dmByChannel)) {
      expect(`${channel}:${resolved}`).toBe(`${channel}:dm`);
    }
  });

  test("Slack tells a public room from a private one", () => {
    // The change this file exists for. Every non-DM used to arrive as one word,
    // so it could not be mapped and the public tier never matched.
    expect(slackConversationVisibility("C0PUBLIC", "channel")).toBe("public");
    expect(slackConversationVisibility("G0PRIVATE", "group")).toBe("private");
    expect(slackConversationVisibility("C0GROUPDM", "mpim")).toBe("private");
  });

  test("a private channel with no channel_type is still private", () => {
    // Slack omits the type on thread replies, edits and deletes. Without the
    // prefix, a threaded message in a private channel would read as public and
    // a permissive rule would reach a private room. This is the assertion that
    // fails if the fallback is ever simplified away.
    expect(slackConversationVisibility("G0PRIVATE", undefined)).toBe("private");
    expect(slackConversationVisibility("D0DIRECT", undefined)).toBe("dm");
  });

  test("a bare C prefix answers nothing rather than guessing public", () => {
    // The failure this shape exists to prevent. A modern multi-person IM is
    // minted with a plain `C` and looks exactly like a public channel, so
    // answering here would hand a group DM a public-channel rule. The caller
    // resolves this case against Slack before emitting.
    expect(slackConversationVisibility("C0UNKNOWN", undefined)).toBeUndefined();
    // An explicit type is still proof, and costs nothing.
    expect(slackConversationVisibility("C0PUBLIC", "channel")).toBe("public");
  });

  test("the free half of the answer makes no network call", () => {
    // Asserted as a property rather than a mock: the helper takes no token and
    // no cache, so it cannot reach Slack even by accident. This is what lets it
    // run on every inbound event.
    expect(slackConversationVisibility.length).toBe(2);
  });

  test("nothing to go on resolves to nothing", () => {
    expect(slackConversationVisibility(undefined, undefined)).toBeUndefined();
  });

  test("Telegram closed groups are private, and a broadcast is neither", () => {
    expect(telegramConversationType("group")).toBe("private");
    expect(telegramConversationType("supergroup")).toBe("private");
    // A Telegram `channel` is a broadcast feed, not a room. Calling it public
    // would let a rule written for conversational rooms govern a surface that
    // is not a conversation.
    expect(telegramConversationType("channel")).toBeUndefined();
  });

  test("a plugin's shared room is not assumed public", () => {
    // Plugins report one word for every shared room, which proves nothing about
    // who can read it.
    expect(pluginConversationType("channel")).toBeUndefined();
    expect(pluginConversationType(undefined)).toBeUndefined();
  });

  test("an unknown surface is never reported public", () => {
    for (const value of [undefined, "", "wat"]) {
      expect(telegramConversationType(value)).toBeUndefined();
      expect(pluginConversationType(value)).toBeUndefined();
    }
  });
});
