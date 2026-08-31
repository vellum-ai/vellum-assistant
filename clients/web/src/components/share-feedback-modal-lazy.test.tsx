/**
 * The wiring around the lazy Share Feedback dialog: what a tap paints while
 * the chunk is in flight, what it paints when the chunk never arrives, whether
 * either placeholder can be dismissed, and whether the retry can actually
 * succeed.
 *
 * The loader is injected rather than mocked at the module boundary, so each
 * case drives the exact promise it needs and the real dialog (which pulls the
 * platform mutation client and Capacitor into the graph) stays out of it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type ComponentType, useEffect, useRef } from "react";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { ShareFeedbackModalLazy } from "@/components/share-feedback-modal-lazy";
import type { ShareFeedbackModalLoader } from "@/components/share-feedback-modal-lazy";
import type { ShareFeedbackModalProps } from "@/components/share-feedback-modal";

/** Both placeholders are dialogs, so every query names the one it means. */
const LOADING_NAME = "Loading the feedback form";
const LOAD_ERROR_NAME = "Couldn't load the feedback form.";

const StubModal: ComponentType<ShareFeedbackModalProps> = () => (
  <div data-testid="share-feedback-modal" />
);

/**
 * Stands in for the real dialog's focus handling: `ShareFeedbackModal` focuses
 * its first field from a 50ms timer started on mount, so the stub does too.
 */
const FocusingStubModal: ComponentType<ShareFeedbackModalProps> = () => {
  const fieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => fieldRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div data-testid="share-feedback-modal">
      <input ref={fieldRef} aria-label="Message" />
    </div>
  );
};

/** An opener beside the dialog, so focus has somewhere real to be pulled to. */
function FeedbackHarness({
  open,
  loader,
}: {
  open: boolean;
  loader: ShareFeedbackModalLoader;
}) {
  return (
    <>
      <button type="button">Share Feedback</button>
      {open ? (
        <ShareFeedbackModalLazy open onClose={() => {}} loader={loader} />
      ) : null}
    </>
  );
}

afterEach(() => {
  cleanup();
});

describe("ShareFeedbackModalLazy", () => {
  test("paints a labelled dialog while the chunk is in flight", async () => {
    const loader: ShareFeedbackModalLoader = () => new Promise(() => {});

    render(<ShareFeedbackModalLazy open onClose={() => {}} loader={loader} />);

    // A dialog, not a bare backdrop: that is what carries the focus trap and
    // the escape route while the chunk is still on the wire.
    const placeholder = await screen.findByRole("dialog", {
      name: LOADING_NAME,
    });
    expect(placeholder.contains(screen.getByRole("status"))).toBe(true);
  });

  test("escape dismisses the placeholder through the opener callback", async () => {
    let closed = 0;
    const loader: ShareFeedbackModalLoader = () => new Promise(() => {});

    render(
      <ShareFeedbackModalLazy
        open
        onClose={() => {
          closed += 1;
        }}
        loader={loader}
      />,
    );

    await screen.findByRole("dialog", { name: LOADING_NAME });
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(closed).toBe(1);
    });
  });

  // Suspense swaps the placeholder out for the dialog, so the placeholder's
  // dialog unmounts while the real one is mounting. Whatever Radix does with
  // focus on that unmount has to leave the dialog's own focus standing rather
  // than pulling the user back to the control they opened it from.
  test("focus ends up inside the dialog once its chunk arrives", async () => {
    let resolveLoad: (module: {
      default: ComponentType<ShareFeedbackModalProps>;
    }) => void = () => {};
    const loader: ShareFeedbackModalLoader = () =>
      new Promise((resolve) => {
        resolveLoad = resolve;
      });

    const { rerender } = render(
      <FeedbackHarness open={false} loader={loader} />,
    );
    const opener = screen.getByRole("button", { name: "Share Feedback" });
    act(() => {
      opener.focus();
    });

    rerender(<FeedbackHarness open loader={loader} />);
    await screen.findByRole("dialog", { name: LOADING_NAME });

    await act(async () => {
      resolveLoad({ default: FocusingStubModal });
    });

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: "Message" }),
      );
    });
    expect(document.activeElement).not.toBe(opener);
  });

  test("surfaces a failed load, and retrying loads the dialog", async () => {
    let attempts = 0;
    const loader: ShareFeedbackModalLoader = () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("chunk unavailable"))
        : Promise.resolve({ default: StubModal });
    };

    render(<ShareFeedbackModalLazy open onClose={() => {}} loader={loader} />);

    await screen.findByRole("dialog", { name: LOAD_ERROR_NAME });

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    // React.lazy caches the rejected import on the component it created, so
    // this only passes if the retry minted a new one.
    await waitFor(() => {
      expect(screen.getByTestId("share-feedback-modal")).toBeTruthy();
    });
    expect(attempts).toBe(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Focus has to land inside the failure, not stay on whatever opened the
  // dialog behind it. Of the two actions, recovery is the one worth landing on.
  test("the failure opens focused on the recovery", async () => {
    const loader: ShareFeedbackModalLoader = () =>
      Promise.reject(new Error("chunk unavailable"));

    render(<ShareFeedbackModalLazy open onClose={() => {}} loader={loader} />);

    await screen.findByRole("dialog", { name: LOAD_ERROR_NAME });
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Try again" }),
      );
    });
  });

  test("the failure's Close hands control back to the opener", async () => {
    let closed = 0;
    const loader: ShareFeedbackModalLoader = () =>
      Promise.reject(new Error("chunk unavailable"));

    render(
      <ShareFeedbackModalLazy
        open
        onClose={() => {
          closed += 1;
        }}
        loader={loader}
      />,
    );

    await screen.findByRole("dialog", { name: LOAD_ERROR_NAME });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(closed).toBe(1);
  });

  test("escape dismisses the failure through the same opener callback", async () => {
    let closed = 0;
    const loader: ShareFeedbackModalLoader = () =>
      Promise.reject(new Error("chunk unavailable"));

    render(
      <ShareFeedbackModalLazy
        open
        onClose={() => {
          closed += 1;
        }}
        loader={loader}
      />,
    );

    await screen.findByRole("dialog", { name: LOAD_ERROR_NAME });
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(closed).toBe(1);
    });
  });
});
