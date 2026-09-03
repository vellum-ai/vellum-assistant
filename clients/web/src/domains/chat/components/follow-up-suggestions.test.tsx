/**
 * Tests for the follow-up suggestion chips under the latest assistant reply.
 *
 * Two things are worth pinning. The gate, because it is what keeps the surface
 * from stacking a second set of buttons under a turn that already asked the
 * user something, or from offering a next message while one is still being
 * written. And the click, because the chip's whole contract is that its visible
 * text is what gets sent.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  FollowUpSuggestions,
  shouldShowFollowUpSuggestions,
} from "@/domains/chat/components/follow-up-suggestions";

const SUGGESTIONS = ["Compare the two options", "Draft the summary"];

/** The gate's inputs with nothing suppressing the chips. */
const OPEN = {
  enabled: true,
  suggestions: SUGGESTIONS,
  turnActive: false,
  awaitingInteraction: false,
};

afterEach(() => {
  cleanup();
});

describe("shouldShowFollowUpSuggestions", () => {
  test("shows the chips when the flag is on and the turn has settled", () => {
    expect(shouldShowFollowUpSuggestions(OPEN)).toBe(true);
  });

  test("shows nothing when the flag is off", () => {
    expect(shouldShowFollowUpSuggestions({ ...OPEN, enabled: false })).toBe(
      false,
    );
  });

  test("shows nothing while the turn is still running", () => {
    expect(shouldShowFollowUpSuggestions({ ...OPEN, turnActive: true })).toBe(
      false,
    );
  });

  test("shows nothing when the turn ended on a surface awaiting an answer", () => {
    // A choice surface or an `ask_question` card renders its own buttons, so
    // chips underneath would offer a second way to answer one question.
    expect(
      shouldShowFollowUpSuggestions({ ...OPEN, awaitingInteraction: true }),
    ).toBe(false);
  });

  test("shows nothing when the daemon returned no suggestions", () => {
    expect(shouldShowFollowUpSuggestions({ ...OPEN, suggestions: [] })).toBe(
      false,
    );
  });
});

describe("FollowUpSuggestions", () => {
  test("renders one chip per suggestion inside a labelled group", () => {
    render(
      <FollowUpSuggestions suggestions={SUGGESTIONS} onSelect={() => {}} />,
    );

    const group = screen.getByRole("group", { name: "Suggested follow-ups" });
    const chips = group.querySelectorAll("button");
    expect([...chips].map((chip) => chip.textContent)).toEqual(SUGGESTIONS);
  });

  test("sends the picked chip's own text", () => {
    const sent: string[] = [];
    render(
      <FollowUpSuggestions
        suggestions={SUGGESTIONS}
        onSelect={(suggestion) => sent.push(suggestion)}
      />,
    );

    fireEvent.click(screen.getByText("Draft the summary"));

    expect(sent).toEqual(["Draft the summary"]);
  });

  test("drops anything past the second suggestion", () => {
    render(
      <FollowUpSuggestions
        suggestions={[...SUGGESTIONS, "Third one"]}
        onSelect={() => {}}
      />,
    );

    expect(screen.queryByText("Third one")).toBeNull();
    expect(screen.getAllByRole("button").length).toBe(2);
  });

  test("renders nothing when there is nothing to suggest", () => {
    const { container } = render(
      <FollowUpSuggestions suggestions={[]} onSelect={() => {}} />,
    );

    expect(container.innerHTML).toBe("");
  });
});
