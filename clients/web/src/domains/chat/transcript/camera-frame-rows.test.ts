import { describe, expect, test } from "bun:test";

import { isCameraFrameRow } from "@/domains/chat/transcript/camera-frame-rows";
import type { DisplayMessage } from "@/domains/chat/types/types";

describe("isCameraFrameRow", () => {
  test.each([
    [{ role: "user", isCameraFrame: true }, true],
    [{ role: "assistant", isCameraFrame: true }, false],
    [{ role: "user" }, false],
    [{ role: "user", isCameraFrame: false }, false],
    [{ role: "user", textSegments: ["(camera frame)"] }, false],
  ] satisfies [Omit<DisplayMessage, "id">, boolean][])(
    "classifies %j as %s",
    (message, expected) => {
      expect(isCameraFrameRow({ id: "message-1", ...message })).toBe(expected);
    },
  );
});
