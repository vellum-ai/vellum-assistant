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

const { DocumentComposerPanel } = await import(
  "@/domains/chat/components/document-composer-panel"
);

afterEach(() => {
  cleanup();
  hookStatus = "idle";
  submitMock.mockClear();
  lastComposerProps = {};
});

const DOC = { surfaceId: "surf-1", conversationId: "conv-1" };

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
