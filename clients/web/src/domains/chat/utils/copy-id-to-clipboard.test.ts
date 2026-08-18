/**
 * Covers the delegation and the wording, which is all this helper owns. The
 * outcome of the write itself belongs to `copyToClipboard` and is covered in
 * `lib/copy-to-clipboard.test.ts`.
 *
 * `t` is deliberately not mocked. The test setup pins i18next to English, so
 * these assertions resolve real catalog entries: a key that is missing or
 * misspelled comes back as its own key path and fails here, which a mocked
 * translator would hide.
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
  test("hands the conversation id and its catalog messages to the shared helper", () => {
    copyIdToClipboard("conv_123", "conversation");

    expect(copyToClipboardMock).toHaveBeenCalledWith("conv_123", {
      successMessage: "Conversation ID copied to clipboard.",
      errorMessage: "Couldn't copy the conversation ID.",
    });
  });

  test("gives the group its own two sentences, not the conversation's relabelled", () => {
    copyIdToClipboard("grp_456", "group");

    expect(copyToClipboardMock).toHaveBeenCalledWith("grp_456", {
      successMessage: "Group ID copied to clipboard.",
      errorMessage: "Couldn't copy the group ID.",
    });
  });
});
