import { describe, expect, test } from "bun:test";

import { getMessageRenderKind } from "@/domains/chat/transcript/message-render-kind";
import type { DisplayMessage } from "@/domains/chat/types/types";

const user: DisplayMessage = { id: "user-123", role: "user" };
const reaction: DisplayMessage["reaction"] = {
  emoji: "🎉",
  op: "added",
  targetMessageId: "message-123",
  selfAuthored: false,
};
const slackMessage: DisplayMessage["slackMessage"] = {
  channelId: "channel-123",
  channelTs: "123.456",
  eventKind: "reaction",
};

describe("getMessageRenderKind", () => {
  test.each([
    [user, "user"],
    [{ ...user, role: "assistant" }, "other"],
    [{ ...user, reaction }, "reaction"],
    [{ ...user, slackMessage }, "slackReaction"],
    [{ ...user, reaction, slackMessage }, "slackReaction"],
    [{ ...user, isNoResponse: true, slackMessage }, "noResponse"],
    [{ ...user, isNoResponse: true, reaction }, "reaction"],
    [
      { ...user, isSystemCard: true, reaction, isNoResponse: true },
      "systemCard",
    ],
    [
      { ...user, deletedAt: 0, isSystemCard: true, reaction, slackMessage },
      "deleted",
    ],
  ] satisfies Array<[DisplayMessage, string]>)(
    "classifies %j as %s",
    (message, expected) => {
      expect(getMessageRenderKind(message)).toBe(expected);
    },
  );
});
