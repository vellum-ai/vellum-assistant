/**
 * Tests for the store-driven Add Credits modal mount: it opens from
 * `useAddCreditsModalStore`, resets the store on close, and (the reason the
 * open state is store-backed rather than local to a CTA host) keeps an open
 * checkout alive when the CTA that opened it unmounts on a billing-state
 * change.
 *
 * The lazy `AddCreditsModal` is stubbed so opening it needs no query client;
 * the stub forwards `onOpenChange(false)` from a close button so the
 * close-resets-store path is exercised through the modal's own contract.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { useAddCreditsModalStore } from "@/stores/add-credits-modal-store";
import { useLowBalanceBannerStore } from "@/stores/low-balance-banner-store";

mock.module("@/components/add-credits-modal", () => ({
  AddCreditsModal: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <button
        data-testid="add-credits-modal-stub"
        onClick={() => onOpenChange(false)}
      >
        Close checkout
      </button>
    ) : null,
}));

import { LazyAddCreditsModal } from "./lazy-add-credits-modal";
import { LowBalanceBanner } from "./low-balance-banner";

beforeEach(() => {
  useAddCreditsModalStore.setState({ open: false });
  useLowBalanceBannerStore.setState({ dismissed: false });
});

afterEach(() => {
  cleanup();
});

describe("LazyAddCreditsModal", () => {
  test("renders nothing until the store opens it", async () => {
    const { queryByTestId, findByTestId } = render(<LazyAddCreditsModal />);

    expect(queryByTestId("add-credits-modal-stub")).toBeNull();

    useAddCreditsModalStore.getState().setOpen(true);
    expect(await findByTestId("add-credits-modal-stub")).toBeTruthy();
  });

  test("closing the modal resets the store open state", async () => {
    useAddCreditsModalStore.getState().setOpen(true);
    const { findByTestId, queryByTestId } = render(<LazyAddCreditsModal />);

    fireEvent.click(await findByTestId("add-credits-modal-stub"));

    expect(useAddCreditsModalStore.getState().open).toBe(false);
    expect(queryByTestId("add-credits-modal-stub")).toBeNull();
  });

  test("unmounting the modal host resets the store so the checkout does not reopen", async () => {
    // The modal's single stable mount lives in `ActiveChatView`, which
    // unmounts on SPA navigation (settings/plans), the auto-greet overlay,
    // and lifecycle transitions. A stale `open` would pop the checkout back
    // up uninvoked on the next chat mount.
    useAddCreditsModalStore.getState().setOpen(true);
    const { findByTestId, unmount } = render(<LazyAddCreditsModal />);
    expect(await findByTestId("add-credits-modal-stub")).toBeTruthy();

    unmount();
    expect(useAddCreditsModalStore.getState().open).toBe(false);

    const { queryByTestId } = render(<LazyAddCreditsModal />);
    expect(queryByTestId("add-credits-modal-stub")).toBeNull();
  });

  test("an open checkout survives its CTA host unmounting", async () => {
    // Mirrors the production arrangement: the banner is a conditionally
    // rendered CTA host, the modal is mounted at a stable ancestor.
    const { rerender, getByRole, getByTestId, findByTestId, queryByText } =
      render(
        <>
          <LowBalanceBanner />
          <LazyAddCreditsModal />
        </>,
      );

    fireEvent.click(getByRole("button", { name: "Add credits" }));
    expect(await findByTestId("add-credits-modal-stub")).toBeTruthy();

    // Balance state flips (e.g. a concurrent turn ends and the warn band
    // clears): the banner unmounts, the checkout must stay up. The `{null}`
    // placeholder keeps the modal at the same tree position, mirroring
    // production where the CTA host unmounts elsewhere in the tree while the
    // modal's own mount under `ActiveChatView` stays put.
    rerender(
      <>
        {null}
        <LazyAddCreditsModal />
      </>,
    );

    expect(queryByText("Your credits are running low")).toBeNull();
    expect(getByTestId("add-credits-modal-stub")).toBeTruthy();
    expect(useAddCreditsModalStore.getState().open).toBe(true);
  });
});
