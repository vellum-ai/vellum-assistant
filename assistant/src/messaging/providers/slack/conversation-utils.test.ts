import { describe, expect, test } from "bun:test";

import {
  classifyConversationType,
  isMemberConversation,
  isPrivateConversation,
  slackUserDisplayName,
} from "./conversation-utils.js";
import type { SlackConversation, SlackUser } from "./types.js";

function conv(partial: Partial<SlackConversation>): SlackConversation {
  return { id: "C1", ...partial };
}

describe("classifyConversationType", () => {
  test("IM is a dm", () => {
    expect(classifyConversationType(conv({ is_im: true }))).toBe("dm");
  });

  test("MPIM is a group", () => {
    expect(classifyConversationType(conv({ is_mpim: true }))).toBe("group");
  });

  test("legacy private group is a group", () => {
    expect(classifyConversationType(conv({ is_group: true }))).toBe("group");
  });

  test("everything else is a channel", () => {
    expect(classifyConversationType(conv({ is_channel: true }))).toBe(
      "channel",
    );
    expect(classifyConversationType(conv({}))).toBe("channel");
  });
});

describe("isPrivateConversation", () => {
  test("public channel is not private", () => {
    expect(isPrivateConversation({ is_channel: true, is_private: false })).toBe(
      false,
    );
  });

  test("private channel with is_private flag", () => {
    expect(isPrivateConversation({ is_channel: true, is_private: true })).toBe(
      true,
    );
  });

  test("private channel via is_group (legacy)", () => {
    expect(isPrivateConversation({ is_group: true })).toBe(true);
  });

  test("is_private takes precedence over is_group", () => {
    expect(isPrivateConversation({ is_private: false, is_group: true })).toBe(
      false,
    );
  });

  test("DM defaults to not private when flags absent", () => {
    expect(isPrivateConversation({ is_im: true })).toBe(false);
  });

  test("mpim (group DM) defaults to not private when is_private absent", () => {
    expect(isPrivateConversation({ is_mpim: true })).toBe(false);
  });

  test("undefined flags default to false", () => {
    expect(isPrivateConversation({})).toBe(false);
  });
});

describe("isMemberConversation", () => {
  test("channel with is_member true", () => {
    expect(
      isMemberConversation(conv({ is_channel: true, is_member: true })),
    ).toBe(true);
  });

  test("channel with is_member false or absent", () => {
    expect(
      isMemberConversation(conv({ is_channel: true, is_member: false })),
    ).toBe(false);
    expect(isMemberConversation(conv({ is_channel: true }))).toBe(false);
  });

  test("IMs and MPIMs are member conversations despite missing is_member", () => {
    expect(isMemberConversation(conv({ is_im: true }))).toBe(true);
    expect(isMemberConversation(conv({ is_mpim: true }))).toBe(true);
  });
});

describe("slackUserDisplayName", () => {
  function user(partial: Partial<SlackUser>): SlackUser {
    return { id: "U1", name: "handle", ...partial };
  }

  test("prefers profile display_name", () => {
    expect(
      slackUserDisplayName(
        user({
          profile: { display_name: "Alice Smith", real_name: "Alice S." },
          real_name: "Alice",
        }),
      ),
    ).toBe("Alice Smith");
  });

  test("falls back through profile real_name, real_name, then name", () => {
    expect(
      slackUserDisplayName(
        user({ profile: { real_name: "Alice S." }, real_name: "Alice" }),
      ),
    ).toBe("Alice S.");
    expect(slackUserDisplayName(user({ real_name: "Alice" }))).toBe("Alice");
    expect(slackUserDisplayName(user({}))).toBe("handle");
  });

  test("skips empty-string fields", () => {
    expect(
      slackUserDisplayName(
        user({ profile: { display_name: "" }, real_name: "Alice" }),
      ),
    ).toBe("Alice");
  });
});
