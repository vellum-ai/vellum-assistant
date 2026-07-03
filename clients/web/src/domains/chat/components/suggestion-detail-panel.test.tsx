/**
 * Tests for the presentational `SuggestionDetailPanel`.
 *
 * Renders via `@testing-library/react` (happy-dom registered in test-setup.ts).
 * No jest-dom matchers; we assert with plain bun `expect` against query results
 * and verify footer/close callbacks fire with the right argument.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import type { ThreadSuggestion } from "@/domains/chat/suggestions/types";

import { SuggestionDetailPanel } from "./suggestion-detail-panel";

afterEach(() => {
  cleanup();
});

const SUGGESTION: ThreadSuggestion = {
  id: "email-helper",
  title: "Email Helper",
  iconKey: "gmail",
  prompt: "Help me with my email",
  detail: {
    heading: "Email Helper",
    description: "Triage your inbox and draft replies in seconds.",
    requirements: [
      { id: "gmail", label: "Gmail access", status: "ready" },
      {
        id: "calendar",
        label: "Calendar plugin",
        status: "install",
        hint: "Need to install this, but it's easy.",
      },
    ],
    capabilities: ["Summarize unread email", "Draft replies"],
  },
};

function noop() {}

describe("SuggestionDetailPanel", () => {
  test("renders heading, description, requirements, and capabilities", () => {
    const { getByText } = render(
      <SuggestionDetailPanel
        suggestion={SUGGESTION}
        onClose={noop}
        onConfirm={noop}
      />,
    );

    expect(getByText("Email Helper")).toBeTruthy();
    expect(
      getByText("Triage your inbox and draft replies in seconds."),
    ).toBeTruthy();
    expect(getByText("Gmail access")).toBeTruthy();
    expect(getByText("Calendar plugin")).toBeTruthy();
    expect(getByText("Need to install this, but it's easy.")).toBeTruthy();
    expect(getByText("Summarize unread email")).toBeTruthy();
    expect(getByText("Draft replies")).toBeTruthy();
  });

  test("calls onConfirm with the suggestion when the primary action is clicked", () => {
    const onConfirm = mock((_suggestion: ThreadSuggestion) => {});
    const { getByText } = render(
      <SuggestionDetailPanel
        suggestion={SUGGESTION}
        onClose={noop}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(getByText("Let's do it!"));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(SUGGESTION);
  });

  test("calls onClose when the close button is clicked", () => {
    const onClose = mock(() => {});
    const { getByLabelText } = render(
      <SuggestionDetailPanel
        suggestion={SUGGESTION}
        onClose={onClose}
        onConfirm={noop}
      />,
    );

    fireEvent.click(getByLabelText("Close"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
