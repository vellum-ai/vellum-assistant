import { describe, expect, test } from "bun:test";

import {
  COMPUTER_USE_SCREENSHOT_ATTACHMENT_IDS_KEY,
  computerUseScreenshotAttachmentIdsFromMetadata,
} from "./conversation-types.js";

describe("computerUseScreenshotAttachmentIdsFromMetadata", () => {
  test("returns valid nonempty attachment ids", () => {
    expect(
      computerUseScreenshotAttachmentIdsFromMetadata({
        [COMPUTER_USE_SCREENSHOT_ATTACHMENT_IDS_KEY]: [
          "attachment-1",
          "",
          42,
          "attachment-2",
        ],
      }),
    ).toEqual(["attachment-1", "attachment-2"]);
  });

  test("treats absent and malformed metadata as legacy", () => {
    expect(computerUseScreenshotAttachmentIdsFromMetadata(undefined)).toEqual(
      [],
    );
    expect(
      computerUseScreenshotAttachmentIdsFromMetadata({
        [COMPUTER_USE_SCREENSHOT_ATTACHMENT_IDS_KEY]: "attachment-1",
      }),
    ).toEqual([]);
  });
});
