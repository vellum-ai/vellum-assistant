/**
 * Covers the delegation and the wording, which is all this helper owns. The
 * outcome of the write itself belongs to `copyToClipboard` and is covered in
 * `lib/copy-to-clipboard.test.ts`.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type * as CopyToClipboardModule from "@/lib/copy-to-clipboard";

const copyToClipboardMock =
  mock<typeof CopyToClipboardModule.copyToClipboard>();
mock.module(
  "@/lib/copy-to-clipboard",
  (): Partial<typeof CopyToClipboardModule> => ({
    copyToClipboard: copyToClipboardMock,
  }),
);

const { copyIdToClipboard } = await import("./copy-id-to-clipboard");

beforeEach(() => {
  copyToClipboardMock.mockClear();
});

describe("copyIdToClipboard", () => {
  test("hands the id and both messages to the shared clipboard helper", () => {
    copyIdToClipboard("conv_123", "Conversation ID");

    expect(copyToClipboardMock).toHaveBeenCalledWith("conv_123", {
      successMessage: "Conversation ID copied to clipboard.",
      errorMessage: "Couldn't copy the conversation id.",
    });
  });

  test("lower-cases the label in the failure message only", () => {
    copyIdToClipboard("grp_456", "Group ID");

    expect(copyToClipboardMock).toHaveBeenCalledWith("grp_456", {
      successMessage: "Group ID copied to clipboard.",
      errorMessage: "Couldn't copy the group id.",
    });
  });
});
