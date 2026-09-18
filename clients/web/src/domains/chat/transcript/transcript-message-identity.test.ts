import { describe, expect, test } from "bun:test";

import type { DisplayMessage } from "@/domains/chat/types/types";
import type { MessageItem } from "@/domains/chat/transcript/types";

import {
  messageItemHasIdentity,
  messageItemIdentityIds,
  messageItemMembers,
} from "./transcript-message-identity";

function message(
  id: string,
  mergedMessageIds?: string[],
  clientMessageId?: string,
): DisplayMessage {
  return { id, role: "user", mergedMessageIds, clientMessageId };
}

test("resolves the host, camera members, and merged aliases once", () => {
  const firstFrame = message("frame-1", ["frame-alias"]);
  const secondFrame = message("frame-2");
  const host = message("utterance", ["utterance-alias"], "utterance-nonce");
  const item: MessageItem = {
    kind: "message",
    key: host.id,
    message: host,
    cameraFrames: [firstFrame, secondFrame],
  };

  expect(messageItemMembers(item)).toEqual([firstFrame, secondFrame, host]);
  expect(messageItemIdentityIds(item)).toEqual([
    "frame-1",
    "frame-alias",
    "frame-2",
    "utterance",
    "utterance-nonce",
    "utterance-alias",
  ]);
  expect(messageItemHasIdentity(item, "utterance-nonce")).toBe(true);
  expect(messageItemHasIdentity(item, "frame-alias")).toBe(true);
  expect(messageItemHasIdentity(item, "missing")).toBe(false);
  expect(messageItemHasIdentity(item, null)).toBe(false);
});

describe("standalone camera frame hosts", () => {
  test("does not return the host twice when it is also the first frame", () => {
    const firstFrame = message("frame-1");
    const secondFrame = message("frame-2");
    const item: MessageItem = {
      kind: "message",
      key: firstFrame.id,
      message: firstFrame,
      cameraFrames: [firstFrame, secondFrame],
    };

    expect(messageItemMembers(item)).toEqual([firstFrame, secondFrame]);
    expect(messageItemIdentityIds(item)).toEqual(["frame-1", "frame-2"]);
  });
});
