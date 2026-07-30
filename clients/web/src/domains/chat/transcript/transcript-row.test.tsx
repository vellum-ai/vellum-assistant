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
});
