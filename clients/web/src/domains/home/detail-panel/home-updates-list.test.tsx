/**
 * Tests for `HomeUpdatesList`.
 *
 * Uses `renderToStaticMarkup` (SSR) like the other detail-panel cards: the
 * list is presentational, so static markup covers what it shows. Which links
 * navigate where is covered against the real bell in
 * `notifications-bell.test.tsx`.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  FIXTURE_CONVERSATION_ID,
  FIXTURE_SECOND_CONVERSATION_ID,
  FIXTURE_SKILL_UPDATES,
  skillUpdateReceipt,
} from "../feed-test-fixtures";

import {
  HomeUpdatesList,
  type HomeUpdatesListProps,
} from "./home-updates-list";

const ALL_SKILLS = new Set(
  FIXTURE_SKILL_UPDATES.map((update) => update.skillId),
);
const ALL_CONVERSATIONS = new Set([
  FIXTURE_CONVERSATION_ID,
  FIXTURE_SECOND_CONVERSATION_ID,
]);

function render(overrides: Partial<HomeUpdatesListProps> = {}): string {
  return renderToStaticMarkup(
    createElement(HomeUpdatesList, {
      item: skillUpdateReceipt({ id: "receipt" }),
      validSkillIds: ALL_SKILLS,
      validConversationIds: ALL_CONVERSATIONS,
      isValidationPending: false,
      onNavigate: () => {},
      onGoToConversation: () => {},
      ...overrides,
    }),
  );
}

function countOf(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("HomeUpdatesList", () => {
  test("renders one section per skill with every summary", () => {
    const html = render();

    expect(countOf(html, 'data-testid="home-updates-list-skill"')).toBe(3);
    for (const update of FIXTURE_SKILL_UPDATES) {
      expect(html).toContain(update.summary);
    }
    // The twice-rewritten skill is named once, as a section, not twice.
    expect(countOf(html, ">Approved PR Merge Gate<")).toBe(1);
  });

  test("links every skill and every resolved source", () => {
    const html = render();

    expect(countOf(html, "<button")).toBe(
      // Three skill names plus the three rewrites that carry a source.
      3 + 3,
    );
  });

  test("a skill or source that is gone renders as text", () => {
    const html = render({
      validSkillIds: new Set(["release-notes-draft"]),
      validConversationIds: new Set([FIXTURE_SECOND_CONVERSATION_ID]),
    });

    expect(countOf(html, "<button")).toBe(1 + 2);
    expect(html).toContain("<h3");
    expect(html).toContain("Approved PR Merge Gate");
  });

  test("leaves out the links the footer already offers", () => {
    const html = render({
      item: skillUpdateReceipt({
        id: "receipt",
        metadata: { skillId: "approved-pr-merge-gate" },
        conversationId: FIXTURE_CONVERSATION_ID,
      }),
    });

    // Two other skills link; of the three sourced rewrites, the one from the
    // footer's conversation does not.
    expect(countOf(html, "<button")).toBe(2 + 2);
  });

  test("keeps every link in place while validation is pending", () => {
    const html = render({
      validSkillIds: new Set(),
      validConversationIds: new Set(),
      isValidationPending: true,
    });

    expect(countOf(html, "<button")).toBe(3 + 3);
  });
});
