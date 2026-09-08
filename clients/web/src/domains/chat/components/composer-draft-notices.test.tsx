import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { useComposerStore } from "@/domains/chat/composer-store";
import { useConversationStore } from "@/stores/conversation-store";

import { ComposerDraftNotices } from "@/domains/chat/components/composer-draft-notices";

function reset() {
  useComposerStore.setState({
    input: "",
    attachments: [],
    attachmentLastError: null,
    restoredDraftConversationId: null,
    documentInput: "",
    documentAttachments: [],
    documentAttachmentLastError: null,
  });
  useConversationStore.setState({ activeConversationId: null });
}

beforeEach(reset);
afterEach(() => {
  cleanup();
  reset();
});

function renderNotices(slot?: "main" | "document"): string {
  const { container } = render(<ComposerDraftNotices slot={slot} />);
  return container.innerHTML;
}

describe("ComposerDraftNotices", () => {
  test("shows the upload-blocked notice while an attachment uploads and there is text", () => {
    useComposerStore.setState({
      input: "hello",
      attachments: [
        {
          kind: "uploading",
          localId: "u1",
          filename: "f",
          mimeType: "text/plain",
          sizeBytes: 1,
        },
      ],
    });
    expect(renderNotices()).toContain(
      "Waiting for the attachment to finish uploading",
    );
  });

  test("no upload-blocked notice when nothing is uploading", () => {
    useComposerStore.setState({ input: "hello" });
    expect(renderNotices()).not.toContain("Waiting for");
  });

  test("shows the restored-draft notice for the active conversation", () => {
    useConversationStore.setState({ activeConversationId: "c1" });
    useComposerStore.setState({
      input: "draft",
      restoredDraftConversationId: "c1",
    });
    expect(renderNotices()).toContain("Draft restored");
  });

  test("hides the restored-draft notice when it belongs to another conversation", () => {
    useConversationStore.setState({ activeConversationId: "c2" });
    useComposerStore.setState({
      input: "draft",
      restoredDraftConversationId: "c1",
    });
    expect(renderNotices()).not.toContain("Draft restored");
  });

  test("surfaces the attachment error", () => {
    useComposerStore.setState({ attachmentLastError: "File is too large" });
    expect(renderNotices()).toContain("File is too large");
  });

  test("clears a stale restored-draft marker from another conversation on mount", () => {
    useConversationStore.setState({ activeConversationId: "c2" });
    useComposerStore.setState({ restoredDraftConversationId: "c1" });
    render(<ComposerDraftNotices />);
    expect(useComposerStore.getState().restoredDraftConversationId).toBe(null);
  });

  describe("document slot", () => {
    test("reads text/attachment state from the document slot, not main", () => {
      useComposerStore.setState({
        // Main slot has text + an uploading attachment: must not leak in.
        input: "main draft",
        attachments: [
          {
            kind: "uploading",
            localId: "u1",
            filename: "f",
            mimeType: "text/plain",
            sizeBytes: 1,
          },
        ],
        documentInput: "doc draft",
        documentAttachments: [],
      });
      expect(renderNotices("document")).not.toContain("Waiting for");
    });

    test("surfaces the document slot's own attachment error", () => {
      useComposerStore.setState({
        attachmentLastError: null,
        documentAttachmentLastError: "Document attachment failed",
      });
      expect(renderNotices("document")).toContain("Document attachment failed");
    });

    test("never shows the restored-draft notice: no draft persistence for this slot", () => {
      useConversationStore.setState({ activeConversationId: "c1" });
      useComposerStore.setState({ restoredDraftConversationId: "c1" });
      expect(renderNotices("document")).not.toContain("Draft restored");
    });
  });
});
