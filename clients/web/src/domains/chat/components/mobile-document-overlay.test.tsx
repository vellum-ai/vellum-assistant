/**
 * Tests for `MobileDocumentOverlay`, the mobile full-screen host for the
 * document viewer, which pins a `"document"`-slot composer (via
 * `DocumentComposerPanel`) below the editor.
 *
 * `ChatComposer`, `DocumentViewerContainer`, and `FilePreviewContainer` are
 * mocked (each is a large component with its own dedicated test suite), so
 * this file's job is only to assert this component's own wiring: the
 * null-render guard, which slot the composer gets, and how the submit hook's
 * `status` drives the composer's disabled props and the transient "Sent"
 * micro-state. `useDocumentComposerSubmit` is mocked too, so `status` is
 * driven directly rather than through a real send: its own behavior
 * (conversation-id resolution, the POST, the toasts) is covered by
 * `use-document-composer-submit.test.ts`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import type { DocumentComposerSendStatus } from "@/domains/chat/hooks/use-document-composer-submit";
import type { OpenedDocumentState } from "@/stores/viewer-store";

let hookStatus: DocumentComposerSendStatus = "idle";
const submitMock = mock(async () => {});

mock.module("@/domains/chat/hooks/use-document-composer-submit", () => ({
  useDocumentComposerSubmit: () => ({
    status: hookStatus,
    submit: submitMock,
  }),
}));

mock.module("@/hooks/use-mobile-overlay-viewport-style", () => ({
  useMobileOverlayViewportStyle: () => ({}),
}));

mock.module("@/domains/chat/components/document-viewer-container", () => ({
  DocumentViewerContainer: () => <div data-testid="viewer" />,
}));

mock.module(
  "@/domains/chat/components/local-file/preview/file-preview-container",
  () => ({
    FilePreviewContainer: () => <div data-testid="file-preview" />,
  }),
);

let lastComposerProps: Record<string, unknown> = {};
mock.module("@/domains/chat/components/chat-composer/chat-composer", () => ({
  ChatComposer: (props: Record<string, unknown>) => {
    lastComposerProps = props;
    return <div data-testid="composer" />;
  },
}));

const { useComposerStore } = await import("@/domains/chat/composer-store");
const { MobileDocumentOverlay } =
  await import("@/domains/chat/components/mobile-document-overlay");

afterEach(() => {
  cleanup();
  hookStatus = "idle";
  submitMock.mockClear();
  lastComposerProps = {};
  useComposerStore.setState({
    documentInput: "",
    documentAttachments: [],
    documentAttachmentLastError: null,
  });
});

function documentState(
  overrides: Partial<Extract<OpenedDocumentState, { source: "document" }>> = {},
): OpenedDocumentState {
  return {
    source: "document",
    surfaceId: "surf-1",
    conversationId: "conv-1",
    documentName: "Doc",
    content: "<p>hi</p>",
    ...overrides,
  };
}

const noop = () => {};

describe("MobileDocumentOverlay", () => {
  test("renders nothing without an opened document", () => {
    const { container } = render(
      <MobileDocumentOverlay
        openedDocumentState={null}
        assistantId="assistant-1"
        onClose={noop}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("renders nothing without an assistant id", () => {
    const { container } = render(
      <MobileDocumentOverlay
        openedDocumentState={documentState()}
        assistantId={null}
        onClose={noop}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("pins a composer scoped to the document slot below the viewer", () => {
    render(
      <MobileDocumentOverlay
        openedDocumentState={documentState()}
        assistantId="assistant-1"
        onClose={noop}
      />,
    );
    expect(screen.getByTestId("viewer")).toBeDefined();
    expect(screen.getByTestId("composer")).toBeDefined();
    expect(lastComposerProps.slot).toBe("document");
    expect(lastComposerProps.assistantId).toBe("assistant-1");
  });

  test("composer is enabled while idle", () => {
    render(
      <MobileDocumentOverlay
        openedDocumentState={documentState()}
        assistantId="assistant-1"
        onClose={noop}
      />,
    );
    expect(lastComposerProps.sendDisabled).toBe(false);
    expect(lastComposerProps.typingDisabled).toBe(false);
    // This surface has no turn-store phase to drive a busy row from.
    expect(lastComposerProps.isAssistantBusy).toBe(false);
  });

  test("disables the composer while the hook reports sending", () => {
    hookStatus = "sending";
    render(
      <MobileDocumentOverlay
        openedDocumentState={documentState()}
        assistantId="assistant-1"
        onClose={noop}
      />,
    );
    expect(lastComposerProps.sendDisabled).toBe(true);
    expect(lastComposerProps.typingDisabled).toBe(true);
  });

  test("shows the transient Sent micro-state after a successful send", () => {
    hookStatus = "sent";
    render(
      <MobileDocumentOverlay
        openedDocumentState={documentState()}
        assistantId="assistant-1"
        onClose={noop}
      />,
    );
    expect(screen.getByText("Sent")).toBeDefined();
  });

  test("hides the Sent micro-state outside the sent status", () => {
    hookStatus = "sending";
    render(
      <MobileDocumentOverlay
        openedDocumentState={documentState()}
        assistantId="assistant-1"
        onClose={noop}
      />,
    );
    expect(screen.queryByText("Sent")).toBeNull();
  });

  test("the workspace-file-preview branch renders no composer", () => {
    render(
      <MobileDocumentOverlay
        openedDocumentState={{
          source: "workspace-file-preview",
          workspacePath: "/tmp/file.txt",
          documentName: "file.txt",
          previewKind: "text",
        }}
        assistantId="assistant-1"
        onClose={noop}
      />,
    );
    expect(screen.getByTestId("file-preview")).toBeDefined();
    expect(screen.queryByTestId("composer")).toBeNull();
  });
});

// The clearing itself belongs to `DocumentComposerPanel` (rendered for real
// here, unlike `ChatComposer`), and is unit-tested in that component's own
// file. These assert the overlay hosts it such that closing the document, or
// switching to another one, takes the staged draft with it.
describe("MobileDocumentOverlay: document-slot lifecycle", () => {
  test("clears staged document-slot text/attachments when the opened document changes", () => {
    const { rerender } = render(
      <MobileDocumentOverlay
        openedDocumentState={documentState({ surfaceId: "surf-A" })}
        assistantId="assistant-1"
        onClose={noop}
      />,
    );
    useComposerStore.setState({
      documentInput: "draft for A",
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
    });

    rerender(
      <MobileDocumentOverlay
        openedDocumentState={documentState({ surfaceId: "surf-B" })}
        assistantId="assistant-1"
        onClose={noop}
      />,
    );

    expect(useComposerStore.getState().documentInput).toBe("");
    expect(useComposerStore.getState().documentAttachments).toHaveLength(0);
  });

  test("clears staged document-slot text/attachments when the overlay closes", () => {
    const { rerender } = render(
      <MobileDocumentOverlay
        openedDocumentState={documentState()}
        assistantId="assistant-1"
        onClose={noop}
      />,
    );
    useComposerStore.getState().setInput("unsent draft", "document");

    rerender(
      <MobileDocumentOverlay
        openedDocumentState={null}
        assistantId="assistant-1"
        onClose={noop}
      />,
    );

    expect(useComposerStore.getState().documentInput).toBe("");
  });

  test("does not clear the document slot on a re-render for the same document", () => {
    const { rerender } = render(
      <MobileDocumentOverlay
        openedDocumentState={documentState()}
        assistantId="assistant-1"
        onClose={noop}
      />,
    );
    useComposerStore.getState().setInput("still typing", "document");

    // Same surfaceId, e.g. a parent re-render triggered by an unrelated prop.
    rerender(
      <MobileDocumentOverlay
        openedDocumentState={documentState()}
        assistantId="assistant-1"
        onClose={noop}
      />,
    );

    expect(useComposerStore.getState().documentInput).toBe("still typing");
  });
});
