/**
 * The section header's "View all chats" destination.
 *
 * Two halves: which sections name a destination at all, and where the
 * control actually points once one does. The hrefs are built by the Old
 * chats page's own producer, so the assertions here are about the mapping
 * (this section type to that filter), not about the query-string format.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { SectionViewAllLink } from "@/domains/chat/components/section-view-all-link";
import { viewAllHrefFor } from "@/domains/chat/components/sidebar-section-item";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";
import { allChatsSearchFor } from "@/domains/chat/utils/all-chats-filters";
import { routes } from "@/utils/routes";

function section(overrides: Partial<SidebarSection>): SidebarSection {
  return {
    key: "k",
    label: "Section",
    all: [],
    type: "recents",
    holdsChannels: false,
    ...overrides,
  } as SidebarSection;
}

describe("viewAllHrefFor", () => {
  test("Chats points at the page's default view", () => {
    expect(
      viewAllHrefFor(section({ type: "recents", holdsChannels: false })),
    ).toBe(routes.allChats);
  });

  test("a channel section preselects its channel", () => {
    const href = viewAllHrefFor(
      section({ type: "channel", channelId: "slack" }),
    );
    expect(href).toBe(
      `${routes.allChats}${allChatsSearchFor({ kind: "channel", channelId: "slack" })}`,
    );
    expect(href).toContain("slack");
  });

  test("a custom group preselects its group", () => {
    const href = viewAllHrefFor(
      section({
        type: "group",
        group: {
          id: "grp-reviews",
          name: "PR Reviews",
          icon: "code",
          conversations: [],
        },
      }),
    );
    expect(href).toBe(
      `${routes.allChats}${allChatsSearchFor({ kind: "group", groupId: "grp-reviews" })}`,
    );
    expect(href).toContain("grp-reviews");
  });

  test("Pinned and the assistant's own section name no destination", () => {
    expect(viewAllHrefFor(section({ type: "pinned" }))).toBeNull();
    expect(viewAllHrefFor(section({ type: "assistant" }))).toBeNull();
  });
});

describe("SectionViewAllLink", () => {
  test("is a named link to the href it is given", () => {
    const { getByLabelText } = render(
      createElement(
        MemoryRouter,
        null,
        createElement(SectionViewAllLink, { to: "/assistant/chats?group=g1" }),
      ),
    );
    const link = getByLabelText("View all chats");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/assistant/chats?group=g1");
  });
});
