/**
 * Tests for `CollapsedRailSections`.
 *
 * The rail's whole contract is that it is the expanded sidebar's section list
 * with the labels taken off: same sections, same order, one tile each. It is
 * not a second list that happens to agree, which is what it drifted into -
 * an extra hardcoded Chats tile survived `all` view gaining a real Chats
 * section, and the rail drew the same conversations twice (LUM-3130).
 *
 * So these assert the mapping itself - tile count against section count, and
 * labels against section labels, in order - rather than that some particular
 * section is present. A test for "Chats renders" passes with two of them.
 *
 * `CollapsedGroupIcon` is stubbed to surface its label, since what it draws
 * (the circle, the dot, the flyout) is covered in its own file. The section
 * query is stubbed too: which rows a section fetches is
 * `use-section-conversations`'s contract, and mounting it here would make
 * this file depend on the daemon capability gates.
 */

import { describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Conversation } from "@/types/conversation-types";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";

/** Every section resolves to the same single row; identity is not what's under test. */
const SECTION_ROWS: Conversation[] = [
  { conversationId: "c1", title: "A conversation" } as Conversation,
];

mock.module("@/domains/chat/use-section-conversations", () => ({
  useSectionConversations: () => SECTION_ROWS,
}));

mock.module("@/domains/chat/components/conversation-rail-flyout", () => ({
  CollapsedGroupFlyout: () => null,
}));

mock.module("@/domains/chat/components/collapsed-group-icon", () => ({
  getGroupIndicatorState: () => null,
  GroupIndicatorDot: () => null,
  CollapsedGroupIcon: ({ label }: { label: ReactNode }) =>
    createElement("button", { "data-testid": "rail-tile" }, String(label)),
}));

const { CollapsedRailSections } = await import(
  "@/domains/chat/components/collapsed-rail-sections"
);

function railLabels(sections: SidebarSection[]): string[] {
  const html = renderToStaticMarkup(
    <CollapsedRailSections sections={sections} assistantId="asst-1" />,
  );
  return [...html.matchAll(/data-testid="rail-tile">([^<]*)</g)].map(
    (m) => m[1] ?? "",
  );
}

const PINNED: SidebarSection = {
  type: "pinned",
  key: "pinned",
  label: "Pinned",
  all: SECTION_ROWS,
};
const CHATS: SidebarSection = {
  type: "recents",
  key: "recents",
  label: "Chats",
  all: SECTION_ROWS,
  holdsChannels: true,
};
const SLACK: SidebarSection = {
  type: "channel",
  key: "channel:slack",
  label: "Slack",
  all: SECTION_ROWS,
  channelId: "slack",
};

describe("CollapsedRailSections", () => {
  /* `all` view: Chats holds the channel conversations itself, so the rail is
     Pinned + Chats and nothing else. The regression drew a second Chats tile
     here from a list published alongside `sections`, so this counts the tiles
     rather than asking whether Chats is present - two of them satisfy that. */
  test("draws one tile per section in all view, Chats included exactly once", () => {
    const labels = railLabels([PINNED, CHATS]);

    expect(labels).toEqual(["Pinned", "Chats"]);
    expect(labels.filter((l) => l === "Chats")).toHaveLength(1);
  });

  /* Grouped view is the arrangement the bug hid in: with channel sections
     present the extra tile was suppressed, so the rail looked correct here
     while `all` view - the default - showed the duplicate. Both views are
     asserted so a fix that only holds in one of them fails. */
  test("draws one tile per section in grouped view", () => {
    const labels = railLabels([
      PINNED,
      { ...CHATS, holdsChannels: false },
      SLACK,
    ]);

    expect(labels).toEqual(["Pinned", "Chats", "Slack"]);
  });

  /* Order is the user's, stored per assistant, and the rail has no ordering
     of its own to disagree with it. */
  test("keeps the order it is handed", () => {
    expect(railLabels([SLACK, CHATS, PINNED])).toEqual([
      "Slack",
      "Chats",
      "Pinned",
    ]);
  });

  /* No sections means no tiles - not a fallback tile standing in for a list
     that isn't there, which is the shape the duplicate came in. */
  test("draws nothing when there are no sections", () => {
    expect(railLabels([])).toEqual([]);
  });
});
