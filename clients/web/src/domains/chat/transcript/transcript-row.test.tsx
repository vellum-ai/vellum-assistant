/**
 * Dispatch tests for `TranscriptRow`'s `creditsUpsell` kind. The card itself
 * is stubbed (its CTA behavior is covered by `credits-upsell-card.test.tsx`);
 * these tests pin that the transcript renders the substituted item through the
 * card component rather than any message-body machinery.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

mock.module("@/domains/chat/components/credits-upsell-card", () => ({
  CreditsUpsellCard: () => <div data-testid="credits-upsell-card-stub" />,
}));

import { TranscriptRow } from "@/domains/chat/transcript/transcript-row";
import type { CreditsUpsellItem } from "@/domains/chat/transcript/types";

afterEach(() => {
  cleanup();
});

describe("TranscriptRow creditsUpsell dispatch", () => {
  test("renders a creditsUpsell item via CreditsUpsellCard", () => {
    const item: CreditsUpsellItem = {
      kind: "creditsUpsell",
      key: "credits-upsell-m1",
      messageId: "m1",
    };

    const { getByTestId } = render(
      <TranscriptRow item={item} onSurfaceAction={() => {}} />,
    );

    expect(getByTestId("credits-upsell-card-stub")).toBeTruthy();
  });

  test("substituted cards keep the msg-<id> anchor of the row they replace", () => {
    // `TranscriptHandle.scrollToMessage` and the `?message=<id>` deep link
    // resolve rows via `getElementById("msg-<id>")`, so the substitution must
    // not drop the anchor the underlying message row would have had.
    const item: CreditsUpsellItem = {
      kind: "creditsUpsell",
      key: "credits-upsell-m1",
      messageId: "m1",
    };

    const { container } = render(
      <TranscriptRow item={item} onSurfaceAction={() => {}} />,
    );

    const anchor = container.querySelector("#msg-m1");
    expect(anchor).toBeTruthy();
    expect(anchor!.querySelector('[data-testid="credits-upsell-card-stub"]'))
      .toBeTruthy();
  });

  test("the proactive card (no messageId) renders without a msg anchor", () => {
    const item: CreditsUpsellItem = {
      kind: "creditsUpsell",
      key: "credits-upsell-proactive",
    };

    const { container, getByTestId } = render(
      <TranscriptRow item={item} onSurfaceAction={() => {}} />,
    );

    expect(getByTestId("credits-upsell-card-stub")).toBeTruthy();
    expect(container.querySelector('[id^="msg-"]')).toBeNull();
  });
});
