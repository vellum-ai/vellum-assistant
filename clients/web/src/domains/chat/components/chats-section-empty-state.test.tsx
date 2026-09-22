/**
 * What an empty Chats section says, with the Done flag and without it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router";

import { ChatsSectionEmptyState } from "@/domains/chat/components/chats-section-empty-state";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

const initialSidebarDone = useClientFeatureFlagStore.getState().sidebarDone;

afterEach(() => {
  useClientFeatureFlagStore.setState({ sidebarDone: initialSidebarDone });
});

function renderEmptyState(viewAllHref: string | null) {
  return render(
    createElement(
      MemoryRouter,
      null,
      createElement(ChatsSectionEmptyState, { viewAllHref }),
    ),
  );
}

describe("ChatsSectionEmptyState", () => {
  test("with the flag on, says the list is clear and links to All chats", () => {
    useClientFeatureFlagStore.setState({ sidebarDone: true });
    const { getByText, getByRole } = renderEmptyState("/assistant/chats");
    expect(getByText("All caught up.")).toBeTruthy();
    const link = getByRole("link", { name: "View all chats" });
    expect(link.getAttribute("href")).toBe("/assistant/chats");
  });

  test("with the flag on and no destination, offers no link", () => {
    useClientFeatureFlagStore.setState({ sidebarDone: true });
    const { queryByRole } = renderEmptyState(null);
    expect(queryByRole("link")).toBeNull();
  });

  test("with the flag off, says there are no chats yet", () => {
    useClientFeatureFlagStore.setState({ sidebarDone: false });
    const { getByText, queryByRole } = renderEmptyState("/assistant/chats");
    expect(getByText("No chats yet.")).toBeTruthy();
    expect(queryByRole("link")).toBeNull();
  });
});
