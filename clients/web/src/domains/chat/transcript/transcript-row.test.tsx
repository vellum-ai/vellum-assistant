/**
 * Dispatch tests for `TranscriptRow`'s `creditsUpsell` kind. The card itself
 * is stubbed (its CTA behavior is covered by `credits-upsell-card.test.tsx`);
 * these tests pin that the transcript renders the substituted item through the
 * card component rather than any message-body machinery, keeps the replaced
 * row's DOM anchor, and exposes the standard Inspect affordance for the
 * backing message.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

mock.module("@/domains/chat/components/credits-upsell-card", () => ({
  CreditsUpsellCard: () => <div data-testid="credits-upsell-card-stub" />,
}));

import { TranscriptRow } from "@/domains/chat/transcript/transcript-row";
import type { CreditsUpsellItem } from "@/domains/chat/transcript/types";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { textBody } from "@/domains/chat/utils/message-test-helpers";

afterEach(() => {
  cleanup();
});

function makeErrorRow(id: string): DisplayMessage {
  return {
    id,
    role: "assistant",
    ...textBody("I hit a snag: your credits ran out."),
    providerError: { code: "PROVIDER_BILLING", category: "credits_exhausted" },
  };
}

function substitutedItem(id: string): CreditsUpsellItem {
  return {
    kind: "creditsUpsell",
    key: `credits-upsell-${id}`,
    message: makeErrorRow(id),
  };
}

const PROACTIVE_ITEM: CreditsUpsellItem = {
  kind: "creditsUpsell",
  key: "credits-upsell-proactive",
};

describe("TranscriptRow creditsUpsell dispatch", () => {
  test("renders a creditsUpsell item via CreditsUpsellCard", () => {
    const { getByTestId } = render(
      <TranscriptRow item={substitutedItem("m1")} onSurfaceAction={() => {}} />,
    );

    expect(getByTestId("credits-upsell-card-stub")).toBeTruthy();
  });

  test("substituted cards keep the msg-<id> anchor of the row they replace", () => {
    // `TranscriptHandle.scrollToMessage` and the `?message=<id>` deep link
    // resolve rows via `getElementById("msg-<id>")`, so the substitution must
    // not drop the anchor the underlying message row would have had.
    const { container } = render(
      <TranscriptRow item={substitutedItem("m1")} onSurfaceAction={() => {}} />,
    );

    const anchor = container.querySelector("#msg-m1");
    expect(anchor).toBeTruthy();
    expect(anchor!.querySelector('[data-testid="credits-upsell-card-stub"]'))
      .toBeTruthy();
  });

  test("the proactive card (no backing message) renders without a msg anchor", () => {
    const { container, getByTestId } = render(
      <TranscriptRow item={PROACTIVE_ITEM} onSurfaceAction={() => {}} />,
    );

    expect(getByTestId("credits-upsell-card-stub")).toBeTruthy();
    expect(container.querySelector('[id^="msg-"]')).toBeNull();
  });

  test("substituted cards expose the Inspect affordance wired to the backing message", () => {
    // The daemon backfills the failed request's LLM logs onto the
    // provider-error row's message id; while the card substitutes the bubble,
    // the hover Inspect action is the only path to those logs.
    const inspected: string[] = [];
    const { getByTitle } = render(
      <TranscriptRow
        item={substitutedItem("m1")}
        onSurfaceAction={() => {}}
        onInspectMessage={(id) => inspected.push(id)}
      />,
    );

    fireEvent.click(getByTitle("Inspect"));
    expect(inspected).toEqual(["m1"]);
  });

  test("no Inspect affordance without an onInspectMessage handler", () => {
    // Mirrors ordinary rows: the inspector entry point only exists when the
    // LLM inspector is enabled (the parent passes the handler).
    const { container } = render(
      <TranscriptRow item={substitutedItem("m1")} onSurfaceAction={() => {}} />,
    );

    expect(container.querySelector('[title="Inspect"]')).toBeNull();
  });

  test("the proactive card gets no Inspect affordance", () => {
    const { container } = render(
      <TranscriptRow
        item={PROACTIVE_ITEM}
        onSurfaceAction={() => {}}
        onInspectMessage={() => {}}
      />,
    );

    expect(container.querySelector('[title="Inspect"]')).toBeNull();
  });

  test("a coarse-pointer tap reveals the actions; tapping outside dismisses", () => {
    // Touch screens have no hover and no focus-visible path to the actions
    // row, so the substituted card mirrors ordinary rows' tap-to-reveal:
    // tapping the row stamps `data-revealed=true` on the `group/msg` wrapper
    // (which the actions row's `group-data-[revealed=true]/msg:opacity-100`
    // class keys off), and a press outside the row dismisses it.
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: mock((query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        onchange: null,
        addListener: mock(() => {}),
        removeListener: mock(() => {}),
        addEventListener: mock(() => {}),
        removeEventListener: mock(() => {}),
        dispatchEvent: mock(() => false),
      })),
    });

    try {
      const { container, getByTestId } = render(
        <TranscriptRow
          item={substitutedItem("m1")}
          onSurfaceAction={() => {}}
          onInspectMessage={() => {}}
        />,
      );
      const wrapper = container.querySelector("#msg-m1")!;
      expect(wrapper.getAttribute("data-revealed")).toBe("false");

      fireEvent.click(getByTestId("credits-upsell-card-stub"));
      expect(wrapper.getAttribute("data-revealed")).toBe("true");

      fireEvent.pointerDown(document.body);
      expect(wrapper.getAttribute("data-revealed")).toBe("false");
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: originalMatchMedia,
      });
    }
  });

  test("a fine-pointer click does not toggle the reveal state", () => {
    // Desktop keeps hover/focus-visible as the only reveal paths; clicking
    // the row must not latch the actions open.
    const { container, getByTestId } = render(
      <TranscriptRow
        item={substitutedItem("m1")}
        onSurfaceAction={() => {}}
        onInspectMessage={() => {}}
      />,
    );
    const wrapper = container.querySelector("#msg-m1")!;

    fireEvent.click(getByTestId("credits-upsell-card-stub"));
    expect(wrapper.getAttribute("data-revealed")).toBe("false");
  });
});
