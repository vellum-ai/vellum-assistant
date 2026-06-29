/**
 * Tests for `SuggestionCard`.
 *
 * Covers: rendering the suggestion title + its resolved icon (an svg), and
 * invoking `onSelect` with the suggestion object on click. Real-DOM via
 * happy-dom — the card is a plain button with no Radix portals.
 */

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { SuggestionCard } from "@/domains/chat/components/suggestion-card";
import type { ThreadSuggestion } from "@/domains/chat/suggestions/types";

afterEach(() => {
  cleanup();
});

const suggestion: ThreadSuggestion = {
  id: "email-helper",
  title: "Email Helper",
  iconKey: "gmail",
  prompt: "Help me with my email.",
  detail: {
    heading: "Email Helper",
    description: "Triage and draft replies.",
    requirements: [],
    capabilities: [],
  },
};

test("renders the suggestion title and an icon", () => {
  const { getByRole, container } = render(
    <SuggestionCard suggestion={suggestion} onSelect={() => {}} />,
  );

  expect(getByRole("button").textContent).toContain("Email Helper");
  expect(container.querySelector("svg")).not.toBeNull();
});

test("exposes an accessible label", () => {
  const { getByRole } = render(
    <SuggestionCard suggestion={suggestion} onSelect={() => {}} />,
  );

  expect(getByRole("button").getAttribute("aria-label")).toBe(
    "Open suggestion: Email Helper",
  );
});

test("invokes onSelect with the suggestion on click", () => {
  const onSelect = mock((_: ThreadSuggestion) => {});
  const { getByRole } = render(
    <SuggestionCard suggestion={suggestion} onSelect={onSelect} />,
  );

  fireEvent.click(getByRole("button"));

  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onSelect).toHaveBeenCalledWith(suggestion);
});
