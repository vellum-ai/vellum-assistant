/**
 * Tests for `DocumentComposerPanel`, the composer wiring shared by
 * `MobileDocumentOverlay` and, on mobile, `DocumentViewerPage`'s standalone
 * document route. `ChatComposer` and `useDocumentComposerSubmit` are mocked,
 * mirroring `mobile-document-overlay.test.tsx`: this file's job is only to
 * assert the panel's own wiring (the null-render guard, the slot, the
 * disabled/Sent-state derivation, and the bottom-inset default), not
 * `ChatComposer`'s or the submit hook's own behavior.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import type { DocumentComposerSendStatus } from "@/domains/chat/hooks/use-document-composer-submit";

let hookStatus: DocumentComposerSendStatus = "idle";
const submitMock = mock(async () => {});

mock.module("@/domains/chat/hooks/use-document-composer-submit", () => ({
  useDocumentComposerSubmit: () => ({
    status: hookStatus,
    submit: submitMock,
  }),
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

  test("defaults the bottom inset to the overlay's keyboard-aware variable", () => {
    const { container } = render(
      <DocumentComposerPanel assistantId="assistant-1" doc={DOC} />,
    );
    const panel = container.firstChild as HTMLElement;
    expect(panel.style.paddingBottom).toBe("var(--overlay-safe-area-bottom)");
  });

  test("a caller can override the bottom inset", () => {
    // A plain value, not `env(...)`: this test asserts the prop is honored,
    // and happy-dom's CSSOM does not retain an `env()` value the way a real
    // browser does.
    const { container } = render(
      <DocumentComposerPanel
        assistantId="assistant-1"
        doc={DOC}
        bottomInset="12px"
      />,
    );
    const panel = container.firstChild as HTMLElement;
    expect(panel.style.paddingBottom).toBe("12px");
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
      <DocumentComposerPanel
        assistantId="assistant-1"
        doc={{ ...DOC }}
        bottomInset="12px"
      />,
    );

    expect(useComposerStore.getState().documentInput).toBe("still typing");
  });
});
