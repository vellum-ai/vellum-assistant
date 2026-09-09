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

import { displayReactionEmoji } from "@/domains/chat/transcript/transcript-message-body-shared";
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

describe("TranscriptRow reaction dispatch", () => {
  test("a neutral reaction row renders the reaction line in the shell, never the sentinel", () => {
    const message: DisplayMessage = {
      id: "m-react",
      role: "assistant",
      ...textBody("[reaction]"),
      reaction: {
        emoji: "🎉",
        op: "added",
        targetMessageId: "555.1",
        selfAuthored: true,
      },
    };
    const { getByTestId, queryByText, container } = render(
      <TranscriptRow
        item={{ kind: "message", key: "m-react", message }}
        onSurfaceAction={() => {}}
      />,
    );
    expect(getByTestId("reaction-line-row")).toBeTruthy();
    expect(getByTestId("reaction-line-row").textContent).toContain("🎉");
    expect(queryByText("[reaction]")).toBeNull();
    expect(container.querySelector("#msg-m-react")).toBeTruthy();
  });

  test("a Discord custom emoji renders as its shortcode name, never raw markup", () => {
    const message: DisplayMessage = {
      id: "m-react-custom",
      role: "assistant",
      reaction: {
        emoji: "<:vex:12345>",
        op: "added",
        targetMessageId: "555.2",
        selfAuthored: true,
      },
    };
    const { getByTestId } = render(
      <TranscriptRow
        item={{ kind: "message", key: "m-react-custom", message }}
        onSurfaceAction={() => {}}
      />,
    );
    const text = getByTestId("reaction-line-row").textContent ?? "";
    expect(text).toContain(":vex:");
    expect(text).not.toContain("<:vex:12345>");
  });

  test("a custom emoji sharing a catalog name keeps its identity", () => {
    // A Discord custom emoji named like a catalog shortcode is a distinct
    // guild emoji; the display must stay ":name:" and never swap into the
    // unrelated standard emoji once the catalog loads.
    expect(displayReactionEmoji("<:heart:99>", () => "❤️")).toBe(":heart:");
    expect(displayReactionEmoji("heart", () => "❤️")).toBe("❤️");
    expect(displayReactionEmoji("heart", () => undefined)).toBe(":heart:");
    expect(displayReactionEmoji("🎉", () => undefined)).toBe("🎉");
  });
});

describe("TranscriptRow deliberate-silence dispatch", () => {
  test("an isNoResponse message renders the quiet marker in the message shell", () => {
    // The wire shape: the route strips sentinel text from projected content,
    // so a silent row arrives with the flag and no text. The marker must not
    // depend on content, and the shell must keep the row addressable.
    const message: DisplayMessage = {
      id: "m-silent",
      role: "assistant",
      isNoResponse: true,
    };
    const { getByTestId, container } = render(
      <TranscriptRow
        item={{ kind: "message", key: "m-silent", message }}
        onSurfaceAction={() => {}}
      />,
    );
    expect(getByTestId("no-response-row")).toBeTruthy();
    expect(container.querySelector("#msg-m-silent")).toBeTruthy();
    expect(
      container.querySelector('[data-message-id="m-silent"]'),
    ).toBeTruthy();
  });

  test("a flagged row that still carries sentinel text never renders it", () => {
    const message: DisplayMessage = {
      id: "m-silent-2",
      role: "assistant",
      ...textBody("<no_response/>"),
      isNoResponse: true,
    };
    const { queryByText } = render(
      <TranscriptRow
        item={{ kind: "message", key: "m-silent-2", message }}
        onSurfaceAction={() => {}}
      />,
    );
    expect(queryByText("<no_response/>")).toBeNull();
  });
});

describe("TranscriptRow channel-deletion dispatch", () => {
  test("a deleted row renders the tombstone in the message shell, never its content", () => {
    // The route keeps the stored content for Inspect, so the tombstone must
    // not depend on the content being absent.
    const message: DisplayMessage = {
      id: "m-deleted",
      role: "user",
      ...textBody("the text Slack no longer shows"),
      deletedAt: 1725100001000,
    };
    const { getByTestId, queryByText, container } = render(
      <TranscriptRow
        item={{ kind: "message", key: "m-deleted", message }}
        onSurfaceAction={() => {}}
      />,
    );
    expect(getByTestId("deleted-message-row")).toBeTruthy();
    expect(queryByText("the text Slack no longer shows")).toBeNull();
    expect(container.querySelector("#msg-m-deleted")).toBeTruthy();
    expect(
      container.querySelector('[data-message-id="m-deleted"]'),
    ).toBeTruthy();
  });

  test("deletion wins over the Slack-shaped and reaction renderings", () => {
    const message: DisplayMessage = {
      id: "m-deleted-slack",
      role: "assistant",
      ...textBody("a reply later removed"),
      deletedAt: 1725100001000,
      slackMessage: {
        channelId: "C1",
        channelTs: "1725100000.000100",
        eventKind: "message",
      },
      reaction: {
        emoji: "🎉",
        op: "added",
        targetMessageId: "555.1",
        selfAuthored: true,
      },
    };
    const { getByTestId, queryByTestId, queryByText } = render(
      <TranscriptRow
        item={{ kind: "message", key: "m-deleted-slack", message }}
        onSurfaceAction={() => {}}
      />,
    );
    expect(getByTestId("deleted-message-row")).toBeTruthy();
    expect(queryByTestId("reaction-line-row")).toBeNull();
    expect(queryByText("a reply later removed")).toBeNull();
  });
});

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
    expect(
      anchor!.querySelector('[data-testid="credits-upsell-card-stub"]'),
    ).toBeTruthy();
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
