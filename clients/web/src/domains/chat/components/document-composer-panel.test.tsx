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
import { act, cleanup, render, screen } from "@testing-library/react";

import type { UploadAttachmentResult } from "@/domains/chat/api/messages";
import type { DocumentComposerSendStatus } from "@/domains/chat/hooks/use-document-composer-submit";
import chatEn from "@/i18n/locales/en/chat.json";

let hookStatus: DocumentComposerSendStatus = "idle";
const submitMock = mock(async () => {});

let lastSubmitParams: Record<string, unknown> = {};
mock.module("@/domains/chat/hooks/use-document-composer-submit", () => ({
  useDocumentComposerSubmit: (params: Record<string, unknown>) => {
    lastSubmitParams = params;
    return {
      status: hookStatus,
      submit: submitMock,
    };
  },
}));

let imageAttachmentsAllowed: boolean | null = true;
const imageGateCalls: (string | undefined)[] = [];
mock.module("@/domains/chat/hooks/use-image-attachments-allowed", () => ({
  useImageAttachmentsAllowed: (
    _assistantId: string | null,
    conversationId: string | undefined,
  ) => {
    imageGateCalls.push(conversationId);
    return imageAttachmentsAllowed;
  },
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
const { useConversationStore } = await import("@/stores/conversation-store");
const { setEditChatDraftReplacement } =
  await import("@/utils/edit-chat-session");
const { heldMessageFor, useDocumentComposerReplyStore } =
  await import("@/domains/chat/document-composer-reply-store");
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
  useDocumentComposerReplyStore.setState({ failedSends: new Map() });
  useConversationStore.setState({ draftConversationIds: new Set() });
  window.sessionStorage.clear();
  hookStatus = "idle";
  imageAttachmentsAllowed = true;
  imageGateCalls.length = 0;
  submitMock.mockClear();
  lastComposerProps = {};
  lastSubmitParams = {};
  resetComposerDocumentSlot();
});

const DOC = { surfaceId: "surf-1", conversationId: "conv-1" };
const OTHER_DOC = { surfaceId: "surf-2", conversationId: "conv-2" };

/** A file the user staged in the document slot. */
const STAGED_ATTACHMENTS = [
  {
    kind: "uploaded" as const,
    localId: "a1",
    id: "srv-1",
    filename: "f.txt",
    mimeType: "text/plain",
    sizeBytes: 1,
    previewUrl: null,
  },
];

function stageDocumentDraft() {
  useComposerStore.setState({
    documentInput: "unsent draft",
    documentAttachments: STAGED_ATTACHMENTS,
    documentAttachmentLastError: "Upload failed",
  });
}

/** The draft and the uploaded file a failed send to `surf-1` carried. */
const FAILED_SEND_PAYLOAD = {
  assistantId: "assistant-1",
  surfaceId: "surf-1",
  content: "a note on the draft",
  attachments: [
    {
      id: "srv-1",
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      previewUrl: null,
    },
  ],
};

/** The message held for `surfaceId` under `assistantId`. */
function heldFor(surfaceId: string, assistantId = "assistant-1") {
  return heldMessageFor(
    useDocumentComposerReplyStore.getState(),
    assistantId,
    surfaceId,
  );
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
    act(() => {
      onAddAttachmentFiles(files);
    });
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
      chatEn.composerAttachments.imageNotSupported,
    );
  });

  test("holds an image back while the target model is still unknown", () => {
    // Nothing revalidates a staged image once the profile lands, so an
    // unresolved gate parks the image and says why, rather than staging one
    // the conversation's model may reject.
    imageAttachmentsAllowed = null;
    render(<DocumentComposerPanel assistantId="assistant-1" doc={DOC} />);

    addFiles([image, note]);

    expect(
      useComposerStore
        .getState()
        .documentAttachments.map((att) => att.filename),
    ).toEqual(["note.txt"]);
    expect(useComposerStore.getState().documentAttachmentLastError).toBe(
      chatEn.composerAttachments.imageGateResolving,
    );
  });

  test("gates on the row that replaced the document's retired draft", () => {
    // The send targets the row the daemon minted for the draft this document
    // is still open against, so the gate has to read that row's model.
    useConversationStore.setState({
      draftConversationIds: new Set(["conv-draft"]),
    });
    setEditChatDraftReplacement("conv-draft", "conv-minted");

    render(
      <DocumentComposerPanel
        assistantId="assistant-1"
        doc={{ surfaceId: "surf-1", conversationId: "conv-draft" }}
      />,
    );

    expect(imageGateCalls.at(-1)).toBe("conv-minted");
  });

  test("gates on the global profile while the document is a live draft", () => {
    // Nothing server-side answers to a draft id, so there is no row whose
    // model could be read.
    useConversationStore.setState({
      draftConversationIds: new Set(["conv-draft"]),
    });

    render(
      <DocumentComposerPanel
        assistantId="assistant-1"
        doc={{ surfaceId: "surf-1", conversationId: "conv-draft" }}
      />,
    );

    expect(imageGateCalls.at(-1)).toBeUndefined();
  });

  test("gates on a linked document's own conversation", () => {
    render(<DocumentComposerPanel assistantId="assistant-1" doc={DOC} />);

    expect(imageGateCalls.at(-1)).toBe("conv-1");
  });

  test("hands the gate's verdict to the submit hook", () => {
    // The send re-checks the gate against the attachments it is about to
    // upload, so it reads the same value the filter did.
    imageAttachmentsAllowed = null;
    render(<DocumentComposerPanel assistantId="assistant-1" doc={DOC} />);

    expect(lastSubmitParams.imageAttachmentsAllowed).toBeNull();
  });

  test("keeps the notice visible when the image was the only file", () => {
    imageAttachmentsAllowed = false;
    render(<DocumentComposerPanel assistantId="assistant-1" doc={DOC} />);

    addFiles([image]);

    expect(useComposerStore.getState().documentAttachments).toEqual([]);
    expect(useComposerStore.getState().documentAttachmentLastError).toBe(
      chatEn.composerAttachments.imageNotSupported,
    );
  });
});

describe("DocumentComposerPanel: document-slot lifecycle", () => {
  test("clears the staged document draft when the panel unmounts", () => {
    const { unmount } = render(
      <DocumentComposerPanel assistantId="assistant-1" doc={DOC} />,
    );
    act(() => {
      stageDocumentDraft();
    });

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
    act(() => {
      stageDocumentDraft();
    });

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
    act(() => {
      useComposerStore.getState().setInput("still typing", "document");
    });

    rerender(
      <DocumentComposerPanel assistantId="assistant-1" doc={{ ...DOC }} />,
    );

    expect(useComposerStore.getState().documentInput).toBe("still typing");
  });
});

describe("DocumentComposerPanel: a send the daemon could not persist", () => {
  test("takes the message held for its own document into an empty slot", () => {
    // GIVEN a send to this document that failed while the document was closed
    useDocumentComposerReplyStore
      .getState()
      .stashFailedSend(FAILED_SEND_PAYLOAD);

    // WHEN the document is opened again
    render(<DocumentComposerPanel assistantId="assistant-1" doc={DOC} />);

    // THEN the message is back in the composer, and nothing holds it any more
    expect(useComposerStore.getState().documentInput).toBe(
      "a note on the draft",
    );
    expect(useComposerStore.getState().documentAttachments).toHaveLength(1);
    expect(useComposerStore.getState().documentAttachments[0]).toMatchObject({
      kind: "uploaded",
      id: "srv-1",
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      previewUrl: null,
    });
    expect(heldFor("surf-1")).toBeUndefined();
  });

  test("takes a message held while it is showing that document", () => {
    render(<DocumentComposerPanel assistantId="assistant-1" doc={DOC} />);

    act(() => {
      useDocumentComposerReplyStore
        .getState()
        .stashFailedSend(FAILED_SEND_PAYLOAD);
    });

    expect(useComposerStore.getState().documentInput).toBe(
      "a note on the draft",
    );
    expect(heldFor("surf-1")).toBeUndefined();
  });

  test("leaves another document's message where it is", () => {
    // The panel showing `surf-1` must never stage what was written for
    // `surf-2`, or the next send here would carry that document's files.
    useDocumentComposerReplyStore
      .getState()
      .stashFailedSend({ ...FAILED_SEND_PAYLOAD, surfaceId: "surf-2" });

    render(<DocumentComposerPanel assistantId="assistant-1" doc={DOC} />);

    expect(documentSlot()).toEqual({
      documentInput: "",
      documentAttachments: [],
      documentAttachmentLastError: null,
    });
    expect(heldFor("surf-2")).toBeDefined();
  });

  test("takes a message only under the assistant it went to", () => {
    // GIVEN a message held for surf-1 under assistant-1, whose teleported copy
    // assistant-2 has the same document
    useDocumentComposerReplyStore
      .getState()
      .stashFailedSend(FAILED_SEND_PAYLOAD);

    // WHEN the document opens under assistant-2
    const { unmount } = render(
      <DocumentComposerPanel assistantId="assistant-2" doc={DOC} />,
    );

    // THEN that composer stays empty, and the message keeps waiting
    expect(documentSlot()).toEqual({
      documentInput: "",
      documentAttachments: [],
      documentAttachmentLastError: null,
    });
    expect(heldFor("surf-1")).toEqual(FAILED_SEND_PAYLOAD);

    // WHEN the document opens under assistant-1 again
    unmount();
    render(<DocumentComposerPanel assistantId="assistant-1" doc={DOC} />);

    // THEN the message is back in its composer, and nothing holds it any more
    expect(useComposerStore.getState().documentInput).toBe(
      "a note on the draft",
    );
    expect(heldFor("surf-1")).toBeUndefined();
  });

  test("takes the message held for its document under its own assistant", () => {
    // The teleported copy's composer takes back what was sent to the copy.
    useDocumentComposerReplyStore.getState().stashFailedSend({
      ...FAILED_SEND_PAYLOAD,
      assistantId: "assistant-2",
      content: "the copy's note",
    });

    render(<DocumentComposerPanel assistantId="assistant-2" doc={DOC} />);

    expect(useComposerStore.getState().documentInput).toBe("the copy's note");
    expect(heldFor("surf-1", "assistant-2")).toBeUndefined();
  });

  test("holds the message while a draft typed since occupies the slot", () => {
    // GIVEN a message held for this document and a newer draft in the slot
    useDocumentComposerReplyStore
      .getState()
      .stashFailedSend(FAILED_SEND_PAYLOAD);
    useComposerStore.getState().setInput("the next message", "document");

    // WHEN the document is opened
    render(<DocumentComposerPanel assistantId="assistant-1" doc={DOC} />);

    // THEN the newer draft stands untouched and nothing of the held message
    // is mixed into it, so the message keeps waiting whole
    expect(useComposerStore.getState().documentInput).toBe("the next message");
    expect(useComposerStore.getState().documentAttachments).toEqual([]);
    expect(heldFor("surf-1")).toEqual(FAILED_SEND_PAYLOAD);
  });

  test("holds the message while files staged since occupy the slot", () => {
    // GIVEN a message held for this document and newer files in the slot
    useDocumentComposerReplyStore
      .getState()
      .stashFailedSend(FAILED_SEND_PAYLOAD);
    useComposerStore.setState({ documentAttachments: STAGED_ATTACHMENTS });

    // WHEN the document is opened
    render(<DocumentComposerPanel assistantId="assistant-1" doc={DOC} />);

    // THEN the held draft is not written over the empty text next to files it
    // was never composed with, and the message keeps waiting whole
    expect(useComposerStore.getState().documentInput).toBe("");
    expect(useComposerStore.getState().documentAttachments).toEqual(
      STAGED_ATTACHMENTS,
    );
    expect(heldFor("surf-1")).toEqual(FAILED_SEND_PAYLOAD);
  });

  test("takes the held message once the occupied slot empties", () => {
    // GIVEN a message left waiting while the slot held a draft
    useDocumentComposerReplyStore
      .getState()
      .stashFailedSend(FAILED_SEND_PAYLOAD);
    stageDocumentDraft();
    render(<DocumentComposerPanel assistantId="assistant-1" doc={DOC} />);

    // WHEN that draft leaves the slot, as a send or a clear leaves it
    act(() => {
      useComposerStore.getState().setInput("", "document");
      useComposerStore.getState().fullReset("document");
    });

    // THEN the message is back in the composer, and nothing holds it any more
    expect(useComposerStore.getState().documentInput).toBe(
      "a note on the draft",
    );
    expect(useComposerStore.getState().documentAttachments).toHaveLength(1);
    expect(useComposerStore.getState().documentAttachments[0]).toMatchObject({
      id: "srv-1",
      filename: "notes.txt",
    });
    expect(heldFor("surf-1")).toBeUndefined();
  });
});
