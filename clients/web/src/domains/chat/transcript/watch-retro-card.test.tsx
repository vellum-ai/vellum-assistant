/**
 * Tests for the watch retrospective's in-chat presentation.
 *
 * Two things are worth pinning. The card must not become an editor of the
 * assistant's words: unrecognized markdown goes back out through the caller's
 * renderer untouched and in place. And an answer must land as a staged quote
 * paired to the exact point it answers, because that pairing is the whole
 * reason the alignment pass can be answered without retyping the question.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";
import { WatchRetroCard } from "@/domains/chat/transcript/watch-retro-card";
import type { WatchRetroSegment } from "@/domains/chat/transcript/watch-retro";

afterEach(cleanup);
beforeEach(() => {
  useQuoteReplyStore.getState().clearStagedQuotes();
});

const MESSAGE_ID = "msg-1";

const SEGMENTS: WatchRetroSegment[] = [
  { kind: "markdown", text: "## 1. The task\n\nYou were cleaning Downloads." },
  {
    kind: "gaps",
    heading: "What I'm unsure about",
    lead: "",
    points: ["Which DMG files are safe to remove."],
  },
  {
    kind: "alignment",
    heading: "Alignment pass",
    lead: "Confirm these points:",
    points: ["Should the skill move approved files to Trash?"],
  },
];

function renderCard(segments: readonly WatchRetroSegment[] = SEGMENTS) {
  return render(
    <WatchRetroCard
      segments={segments}
      messageId={MESSAGE_ID}
      renderMarkdown={(markdown) => (
        <div data-testid="markdown">{markdown}</div>
      )}
    />,
  );
}

/** The staged quotes the card has produced, in staging order. */
function staged() {
  return useQuoteReplyStore.getState().stagedQuotes.map((quote) => ({
    quotedText: quote.quotedText,
    replyText: quote.replyText,
    sourceMessageId: quote.sourceMessageId,
  }));
}

describe("WatchRetroCard — what it draws", () => {
  test("renders both answerable sections under the model's own headings", () => {
    renderCard();

    expect(screen.getByText("What I'm unsure about")).toBeDefined();
    expect(screen.getByText("Alignment pass")).toBeDefined();
    expect(screen.getAllByTestId("watch-retro-panel")).toHaveLength(2);
  });

  test("passes unrecognized markdown through verbatim", () => {
    renderCard();

    const markdown = screen.getAllByTestId("markdown");
    expect(markdown[0]?.textContent).toBe(
      "## 1. The task\n\nYou were cleaning Downloads.",
    );
  });

  test("offers agreement on alignment points but not on gaps", () => {
    renderCard();

    // One "Yes", on the alignment panel — a gap has no reading to agree with.
    const agree = screen.getAllByRole("button", { name: "Yes" });
    expect(agree).toHaveLength(1);
    expect(
      agree[0]
        ?.closest('[data-testid="watch-retro-panel"]')
        ?.getAttribute("data-kind"),
    ).toBe("alignment");
  });
});

describe("WatchRetroCard — answering in place", () => {
  test("agreeing stages the point with the answer attached to it", () => {
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Yes" }));

    expect(staged()).toEqual([
      {
        quotedText: "Should the skill move approved files to Trash?",
        replyText: "Yes",
        sourceMessageId: MESSAGE_ID,
      },
    ]);
  });

  test("a typed answer stages against the gap it answers", () => {
    renderCard();

    fireEvent.click(screen.getAllByRole("button", { name: "Answer" })[0]!);
    const field = screen.getByLabelText("Your answer");
    fireEvent.change(field, { target: { value: "Only the ones I approve" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(staged()).toEqual([
      {
        quotedText: "Which DMG files are safe to remove.",
        replyText: "Only the ones I approve",
        sourceMessageId: MESSAGE_ID,
      },
    ]);
  });

  test("an answered point can be taken back", () => {
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(staged()).toEqual([]);
    expect(screen.getAllByRole("button", { name: "Yes" })).toHaveLength(1);
  });

  test("an empty answer stages nothing", () => {
    renderCard();

    fireEvent.click(screen.getAllByRole("button", { name: "Answer" })[0]!);
    const field = screen.getByLabelText("Your answer");
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(staged()).toEqual([]);
  });

  test("a point answered elsewhere in the transcript leaves this row open", () => {
    useQuoteReplyStore.getState().addStagedQuote({
      quotedText: "Should the skill move approved files to Trash?",
      replyText: "Yes",
      sourceMessageId: "some-other-message",
    });

    renderCard();

    expect(screen.getAllByRole("button", { name: "Yes" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});
