/**
 * Tests for `DocumentComposerPanel`, the composer wiring shared by
 * `MobileDocumentOverlay` and, on mobile, `DocumentViewerPage`'s standalone
 * document route. `ChatComposer` and `useDocumentComposerSubmit` are mocked,
 * mirroring `mobile-document-overlay.test.tsx`: this file's job is only to
 * assert the panel's own wiring (the null-render guard, the slot, the
 * placeholder, the disabled/Sent-state derivation, and the bottom-inset
 * default), not `ChatComposer`'s or the submit hook's own behavior.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import type { UploadAttachmentResult } from "@/domains/chat/api/messages";
import type { DocumentComposerSendStatus } from "@/domains/chat/hooks/use-document-composer-submit";
import chatEn from "@/i18n/locales/en/chat.json";

let hookStatus: DocumentComposerSendStatus = "idle";
const submitMock = mock(async () => {});

mock.module("@/domains/chat/hooks/use-document-composer-submit", () => ({
  useDocumentComposerSubmit: () => ({
    status: hookStatus,
    submit: submitMock,
  }),
}));

let imageAttachmentsAllowed = true;
mock.module("@/domains/chat/hooks/use-image-attachments-allowed", () => ({
  useImageAttachmentsAllowed: () => imageAttachmentsAllowed,
}));

// The store uploads what it queues. Spread the real module rather than naming
// its exports, so every other importer keeps the ones it reads.
const actualMessagesApi = await import("@/domains/chat/api/messages");
mock.module("@/domains/chat/api/messages", () => ({
  ...actualMessagesApi,
  uploadChatAttachment: mock(
    async (): Promise<UploadAttachmentResult> => ({ ok: true, id: "srv-up" }),
  ),
}));

let lastComposerProps: Record<string, unknown> = {};
mock.module("@/domains/chat/components/chat-composer/chat-composer", () => ({
  ChatComposer: (props: Record<string, unknown>) => {
    lastComposerProps = props;
    return <div data-testid="composer" />;
  },
}));

const { useComposerStore } = await import("@/domains/chat/composer-store");
const { DocumentComposerPanel } = await import(
  "@/domains/chat/components/document-composer-panel"
);

function resetComposerDocumentSlot() {
  useComposerStore.setState({
    documentInput: "",
    documentAttachments: [],
    documentAttachmentLastError: null,
  });
}

afterEach(() => {
  cleanup();
  hookStatus = "idle";
  imageAttachmentsAllowed = true;
  submitMock.mockClear();
  lastComposerProps = {};
  resetComposerDocumentSlot();
});

const DOC = { surfaceId: "surf-1", conversationId: "conv-1" };
const OTHER_DOC = { surfaceId: "surf-2", conversationId: "conv-2" };

function stageDocumentDraft() {
  useComposerStore.setState({
    documentInput: "unsent draft",
    documentAttachments: [
      {
        kind: "uploaded",
        localId: "a1",
        id: "srv-1",
        filename: "f.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        previewUrl: null,
      },
    ],
    documentAttachmentLastError: "Upload failed",
  });
}

function documentSlot() {
  const state = useComposerStore.getState();
  return {
    documentInput: state.documentInput,
    documentAttachments: state.documentAttachments,
    documentAttachmentLastError: state.documentAttachmentLastError,
  };
}

describe("DocumentComposerPanel", () => {
  test("renders nothing without an assistant id", () => {
    const { container } = render(
      <DocumentComposerPanel assistantId={null} doc={DOC} />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("renders a document-slot composer wired to the submit hook", () => {
    render(<DocumentComposerPanel assistantId="assistant-1" doc={DOC} />);
    expect(screen.getByTestId("composer")).toBeDefined();
    expect(lastComposerProps.slot).toBe("document");
    expect(lastComposerProps.assistantId).toBe("assistant-1");
  });

  test("gives the composer a catalog-backed placeholder", () => {
    // GIVEN a panel rendered against a document
    render(<DocumentComposerPanel assistantId="assistant-1" doc={DOC} />);

    // WHEN the composer reads the props it was handed
    // THEN its placeholder is the catalog's, so every locale reads its own
    // copy rather than the composer's English default
    expect(lastComposerProps.placeholder).toBe(
      chatEn.documentComposer.placeholder,
    );
  });

  test("enables the composer while idle", () => {
    render(<DocumentComposerPanel assistantId="assistant-1" doc={DOC} />);
    expect(lastComposerProps.sendDisabled).toBe(false);
    expect(lastComposerProps.typingDisabled).toBe(false);
  });

  test("disables the composer while the hook reports sending", () => {
    hookStatus = "sending";
    render(<DocumentComposerPanel assistantId="assistant-1" doc={DOC} />);
    expect(lastComposerProps.sendDisabled).toBe(true);
    expect(lastComposerProps.typingDisabled).toBe(true);
  });

  test("disables the composer while it has no document to target", () => {
    // The standalone route hands `null` while its loaded document trails the
    // route param, so nothing can be typed or sent at the document the URL
    // has already left.
    render(<DocumentComposerPanel assistantId="assistant-1" doc={null} />);
    expect(screen.getByTestId("composer")).toBeDefined();
    expect(lastComposerProps.sendDisabled).toBe(true);
    expect(lastComposerProps.typingDisabled).toBe(true);
  });

  test("shows the transient Sent micro-state after a successful send", () => {
    hookStatus = "sent";
    render(<DocumentComposerPanel assistantId="assistant-1" doc={DOC} />);
    expect(screen.getByText("Sent")).toBeDefined();
  });

  test("submitting calls the hook's submit", () => {
    render(<DocumentComposerPanel assistantId="assistant-1" doc={DOC} />);
    const onSubmit = lastComposerProps.onSubmit as (e: {
      preventDefault: () => void;
    }) => void;
    onSubmit({ preventDefault: () => {} });
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  test("pads no bottom safe area of its own", () => {
    // Both hosts sit in a shell that already pads the bottom safe area, so a
    // second inset here would double the gap under the composer.
    const { container } = render(
      <DocumentComposerPanel assistantId="assistant-1" doc={DOC} />,
    );
    const panel = container.firstChild as HTMLElement;
    expect(panel.style.paddingBottom).toBe("");
  });
});

describe("DocumentComposerPanel: attachment vision gate", () => {
  // Real PNG magic bytes: the store refuses an image whose payload matches no
  // known signature, and this test is about the panel's filter, not that one.
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const image = new File([pngBytes], "photo.png", { type: "image/png" });
  const note = new File(["notes"], "note.txt", { type: "text/plain" });

  function addFiles(files: File[]) {
    const onAddAttachmentFiles = lastComposerProps.onAddAttachmentFiles as (
      files: File[],
    ) => void;
    onAddAttachmentFiles(files);
  }

  test("stages every file while the target model can see images", () => {
    render(<DocumentComposerPanel assistantId="assistant-1" doc={DOC} />);

    addFiles([image, note]);

    expect(
      useComposerStore
        .getState()
        .documentAttachments.map((att) => att.filename),
    ).toEqual(["photo.png", "note.txt"]);
    expect(useComposerStore.getState().documentAttachmentLastError).toBeNull();
  });

  test("turns an image away when the target model cannot see one", () => {
    // Below the image-fallback release an image on a non-vision model fails
    // the whole turn at the provider, and by then the send has already
    // cleared the draft, so the panel refuses the image up front.
    imageAttachmentsAllowed = false;
    render(<DocumentComposerPanel assistantId="assistant-1" doc={DOC} />);

    addFiles([image, note]);

    expect(
      useComposerStore
        .getState()
        .documentAttachments.map((att) => att.filename),
    ).toEqual(["note.txt"]);
    expect(useComposerStore.getState().documentAttachmentLastError).toBe(
      chatEn.documentComposer.imageNotSupported,
    );
  });

  test("keeps the notice visible when the image was the only file", () => {
    imageAttachmentsAllowed = false;
    render(<DocumentComposerPanel assistantId="assistant-1" doc={DOC} />);

    addFiles([image]);

    expect(useComposerStore.getState().documentAttachments).toEqual([]);
    expect(useComposerStore.getState().documentAttachmentLastError).toBe(
      chatEn.documentComposer.imageNotSupported,
    );
  });
});

describe("DocumentComposerPanel: document-slot lifecycle", () => {
  test("clears the staged document draft when the panel unmounts", () => {
    const { unmount } = render(
      <DocumentComposerPanel assistantId="assistant-1" doc={DOC} />,
    );
    stageDocumentDraft();

    unmount();

    expect(documentSlot()).toEqual({
      documentInput: "",
      documentAttachments: [],
      documentAttachmentLastError: null,
    });
  });

  test("clears the staged document draft when the panel is pointed at another document", () => {
    // The standalone `/documents/:surfaceId` route keeps one panel instance
    // across param changes, so nothing unmounts to carry the draft away.
    const { rerender } = render(
      <DocumentComposerPanel assistantId="assistant-1" doc={DOC} />,
    );
    stageDocumentDraft();

    rerender(
      <DocumentComposerPanel assistantId="assistant-1" doc={OTHER_DOC} />,
    );

    expect(documentSlot()).toEqual({
      documentInput: "",
      documentAttachments: [],
      documentAttachmentLastError: null,
    });
  });

  test("keeps the staged draft across a re-render for the same document", () => {
    const { rerender } = render(
      <DocumentComposerPanel assistantId="assistant-1" doc={DOC} />,
    );
    useComposerStore.getState().setInput("still typing", "document");

    rerender(
      <DocumentComposerPanel assistantId="assistant-1" doc={{ ...DOC }} />,
    );

    expect(useComposerStore.getState().documentInput).toBe("still typing");
  });
});
