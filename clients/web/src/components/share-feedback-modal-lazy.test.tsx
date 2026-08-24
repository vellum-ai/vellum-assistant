/**
 * The wiring around the lazy Share Feedback dialog: what a tap paints while
 * the chunk is in flight, what it paints when the chunk never arrives, and
 * whether the retry can actually succeed.
 *
 * The loader is injected rather than mocked at the module boundary, so each
 * case drives the exact promise it needs and the real dialog (which pulls the
 * platform mutation client and Capacitor into the graph) stays out of it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ComponentType } from "react";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ShareFeedbackModalLazy } from "@/components/share-feedback-modal-lazy";
import type { ShareFeedbackModalLoader } from "@/components/share-feedback-modal-lazy";
import {
  SHARE_FEEDBACK_MODAL_BACKDROP_CLASS,
  SHARE_FEEDBACK_MODAL_PANEL_CLASS,
} from "@/components/share-feedback-modal-shell";
import type { ShareFeedbackModalProps } from "@/components/share-feedback-modal";

const StubModal: ComponentType<ShareFeedbackModalProps> = () => (
  <div data-testid="share-feedback-modal" />
);

afterEach(() => {
  cleanup();
});

describe("ShareFeedbackModalLazy", () => {
  test("paints the dialog's shell while the chunk is in flight", () => {
    const loader: ShareFeedbackModalLoader = () => new Promise(() => {});

    render(
      <ShareFeedbackModalLazy open onClose={() => {}} loader={loader} />,
    );

    const panel = screen.getByRole("status");
    // Drawn from the shared shell module, so the placeholder cannot drift
    // away from the dialog it stands in for.
    expect(panel.className).toBe(SHARE_FEEDBACK_MODAL_PANEL_CLASS);
    expect(panel.parentElement?.className).toBe(
      SHARE_FEEDBACK_MODAL_BACKDROP_CLASS,
    );
  });

  test("surfaces a failed load, and retrying loads the dialog", async () => {
    let attempts = 0;
    const loader: ShareFeedbackModalLoader = () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("chunk unavailable"))
        : Promise.resolve({ default: StubModal });
    };

    render(
      <ShareFeedbackModalLazy open onClose={() => {}} loader={loader} />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load the feedback form.");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    // React.lazy caches the rejected import on the component it created, so
    // this only passes if the retry minted a new one.
    await waitFor(() => {
      expect(screen.getByTestId("share-feedback-modal")).toBeTruthy();
    });
    expect(attempts).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
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

    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(closed).toBe(1);
  });
});
