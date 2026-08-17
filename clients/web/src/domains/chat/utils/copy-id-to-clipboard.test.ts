/**
 * Pins the delegation and the wording, which is all this helper owns. What
 * happens when a write is refused or the Clipboard API is missing belongs to
 * `copyToClipboard` and is covered in `lib/copy-to-clipboard.test.ts`; a
 * helper that writes for itself is a helper that skips both of those.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const copyToClipboardMock = mock((_text: string, _options: unknown) => {});
mock.module("@/lib/copy-to-clipboard", () => ({
  copyToClipboard: copyToClipboardMock,
}));

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
