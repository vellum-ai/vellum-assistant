/**
 * Tests for `SkillLineageLink` — the quiet "Learned from this conversation"
 * link on skill detail surfaces. The component owns the render gate: only
 * assistant-memory skills with a recorded source conversation get a link.
 *
 * Rendered inside a `MemoryRouter` (the component emits a react-router
 * `<Link>`), via `@testing-library/react` on happy-dom.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { SkillLineageLink } from "./skill-lineage-link";

afterEach(() => {
  cleanup();
});

function renderLink(
  skill: { origin: string; sourceConversationId?: string | null },
  onNavigate?: () => void,
) {
  return render(
    <MemoryRouter>
      <SkillLineageLink skill={skill} onNavigate={onNavigate} />
    </MemoryRouter>,
  );
}

describe("SkillLineageLink", () => {
  test("links an assistant-memory skill with lineage to its source conversation", () => {
    const { getByText } = renderLink({
      origin: "assistant-memory",
      sourceConversationId: "conv-123",
    });

    const link = getByText("Learned from this conversation").closest("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe(
      "/assistant/conversations/conv-123",
    );
  });

  test("renders nothing for non-assistant-memory origins, even with lineage", () => {
    const { container } = renderLink({
      origin: "custom",
      sourceConversationId: "conv-123",
    });

    expect(container.querySelector("a")).toBeNull();
  });

  test("renders nothing for an assistant-memory skill without lineage", () => {
    const { container } = renderLink({ origin: "assistant-memory" });

    expect(container.querySelector("a")).toBeNull();
  });

  test("invokes onNavigate on click (so hosting panels can close)", () => {
    const onNavigate = mock(() => {});
    const { getByText } = renderLink(
      { origin: "assistant-memory", sourceConversationId: "conv-123" },
      onNavigate,
    );

    fireEvent.click(getByText("Learned from this conversation"));

    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
