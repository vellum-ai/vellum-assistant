/**
 * Tests for `AssistantSideMenu`.
 *
 * The web workspace does not pull in `@testing-library/react` — rendering
 * goes through `react-dom/server` and assertions look at the emitted
 * markup. Interactive behavior (Show more, onSelect) is exercised by the
 * SideMenu primitive's own tests; here we verify the composition rules
 * unique to `AssistantSideMenu`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { cleanup } from "@/test-utils.js";

import type { Conversation } from "@/domains/chat/lib/api.js";

import {
  ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT,
  AssistantSideMenu,
} from "@/components/app/assistant/AssistantSideMenu/AssistantSideMenu.js";

afterEach(() => {
  cleanup();
});

function makeConversation(overrides: Partial<Conversation>): Conversation {
  return {
    conversationKey: overrides.conversationKey ?? "k",
    ...overrides,
  };
}

function renderMenu(props: {
  conversations: Conversation[];
  activeConversationKey?: string;
  variant?: "rail" | "overlay";
  /**
   * Whether to include a placeholder footer. Defaults to `true` so the
   * existing tests that assert on the Preferences label still pass. The
   * real consumer passes `<PreferencesMenu />` here, but that pulls in
   * Next.js router + auth context that static-markup tests can't easily
   * satisfy, so we swap in a plain sentinel span.
   */
  includeFooterAction?: boolean;
}): string {
  const includeFooterAction = props.includeFooterAction ?? true;
  return renderToStaticMarkup(
    createElement(AssistantSideMenu, {
      assistantId: "asst-1",
      collapsed: false,
      variant: props.variant ?? "rail",
      conversations: props.conversations,
      activeConversationKey: props.activeConversationKey,
      onSelectConversation: () => {},
      footerAction: includeFooterAction
        ? createElement("span", null, "Preferences")
        : undefined,
    }),
  );
}

describe("AssistantSideMenu · Conversations category rows", () => {
  test("renders a Conversations section header with all four category rows", () => {
    /**
     * The body is a single "Conversations" section containing Pinned,
     * Scheduled, Background, and Recents as peer rows beneath the
     * "Conversations" header. Auto-analysis (reflections) conversations
     * appear as a sub-group inside Background.
     */
    // GIVEN a mix of conversations covering every category
    const conversations = [
      makeConversation({ conversationKey: "p1", isPinned: true }),
      makeConversation({
        conversationKey: "s1",
        conversationType: "scheduled",
      }),
      makeConversation({
        conversationKey: "b1",
        conversationType: "background",
        source: "heartbeat",
      }),
      makeConversation({ conversationKey: "r1", title: "Recent thread" }),
      makeConversation({
        conversationKey: "rf1",
        conversationType: "background",
        source: "auto-analysis",
      }),
    ];

    // WHEN we render the menu
    const html = renderMenu({ conversations });

    // THEN the section header and every category label are present
    expect(html).toContain(">Conversations<");
    expect(html).toContain(">Pinned<");
    expect(html).toContain(">Scheduled<");
    expect(html).toContain(">Background<");
    expect(html).toContain(">Recents<");
    expect(html).not.toContain(">Slack<");
    // There is no top-level "Reflections" section — auto-analysis
    // conversations are sub-grouped inside Background by
    // backgroundSubGroups.ts.
  });

  test("renders Slack as a conditional peer section before Recents", () => {
    const conversations = [
      makeConversation({ conversationKey: "regular", title: "Regular thread" }),
      makeConversation({
        conversationKey: "slack",
        title: "Slack thread",
        originChannel: "slack",
        groupId: "system:all",
      }),
    ];

    const html = renderMenu({ conversations });
    expect(html).toContain(">Slack<");

    const backgroundIndex = html.indexOf(">Background<");
    const slackIndex = html.indexOf(">Slack<");
    const recentsIndex = html.indexOf(">Recents<");
    expect(backgroundIndex).toBeGreaterThanOrEqual(0);
    expect(slackIndex).toBeGreaterThan(backgroundIndex);
    expect(recentsIndex).toBeGreaterThan(slackIndex);
  });

  test("renders a count badge only for non-empty category buckets", () => {
    // GIVEN conversations that populate only Background + Recents
    const conversations = [
      makeConversation({
        conversationKey: "b1",
        conversationType: "background",
        source: "heartbeat",
      }),
      makeConversation({
        conversationKey: "b2",
        conversationType: "background",
        source: "heartbeat",
      }),
      makeConversation({ conversationKey: "r1" }),
    ];

    // WHEN we render the menu
    const html = renderMenu({ conversations });

    // THEN the Background row shows "2" and the Recents row shows "1"
    expect(html).toContain(">2<");
    expect(html).toContain(">1<");
  });
});

describe("AssistantSideMenu · Show more affordance", () => {
  test("hides 'Show more' when the recent count is at or below the limit", () => {
    /**
     * With exactly ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT unpinned threads, every
     * one must render and no Show more row should appear.
     */
    // GIVEN exactly ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT unpinned conversations
    const conversations = Array.from(
      { length: ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT },
      (_, index) =>
        makeConversation({
          conversationKey: `k-${index}`,
          title: `Thread ${index}`,
        }),
    );

    // WHEN we render the menu
    const html = renderMenu({ conversations });

    // THEN the Show more trigger is absent
    expect(html).not.toContain("Show more");
  });

  test("renders 'Show more' when the recent count exceeds the limit", () => {
    /**
     * With more than the visible thread limit the tail is hidden behind a
     * Show more row. The row uses `emphasized` so it reads as a call-to-action.
     */
    // GIVEN one more than the visible limit
    const conversations = Array.from(
      { length: ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT + 1 },
      (_, index) =>
        makeConversation({
          conversationKey: `k-${index}`,
          title: `Thread ${index}`,
        }),
    );

    // WHEN we render the menu
    const html = renderMenu({ conversations });

    // THEN the Show more label appears
    expect(html).toContain("Show more");
  });

  test("wires the same 'Show more' affordance for Slack conversations", () => {
    const src = readFileSync(
      new URL("./AssistantSideMenu.tsx", import.meta.url).pathname,
      "utf8",
    );

    expect(src).toContain(
      "slack.slice(0, ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT)",
    );
    expect(src).toContain(
      "slack.length > ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT",
    );
    expect(src).toContain("showMoreSlackVisible");
    expect(src).toContain("onSelect={() => setShowAllSlack(true)}");
  });
});

describe("AssistantSideMenu · active thread accessibility", () => {
  test("active conversation row sets aria-current=page", () => {
    /**
     * The active row is marked both via SideMenu.Item's `active` prop
     * (which drives visual styling) and — internally to the SideMenu
     * primitive — via `aria-current="page"` for screen readers. Consumers
     * rely on this mapping staying intact. We assert on the conversation
     * row's markup specifically by slicing the surrounding <button> around
     * its title text, which is unique across the menu.
     */
    // GIVEN a conversation list with one active thread
    const conversations = [
      makeConversation({
        conversationKey: "a",
        title: "Alpha thread title",
      }),
      makeConversation({
        conversationKey: "b",
        title: "Beta thread title",
      }),
    ];

    // WHEN we render the menu with `b` marked active
    const html = renderMenu({
      conversations,
      activeConversationKey: "b",
    });

    // THEN the active conversation row's markup contains the
    // `aria-current="page"` attribute, and the inactive row does not.
    // We locate each row by its unique title text (static Header rows use
    // different labels so they can't alias a conversation) and slice the
    // surrounding <button ...> markup to inspect its attributes.
    const sliceButtonAround = (title: string): string => {
      const titleIndex = html.indexOf(title);
      expect(titleIndex).toBeGreaterThanOrEqual(0);
      const buttonOpen = html.lastIndexOf("<button", titleIndex);
      expect(buttonOpen).toBeGreaterThanOrEqual(0);
      return html.slice(buttonOpen, titleIndex);
    };

    expect(sliceButtonAround("Beta thread title")).toContain(
      'aria-current="page"',
    );
    expect(sliceButtonAround("Alpha thread title")).not.toContain(
      "aria-current",
    );
  });
});

describe("AssistantSideMenu · footer slot behavior", () => {
  test("renders the footer slot when `footerAction` is provided", () => {
    /**
     * The consumer decides whether to show the footer by passing a
     * `footerAction` node. The sidebar renders it inside a Footer slot
     * with a Separator above, but doesn't know or care what it is — the
     * consumer owns the entire content (typically a PreferencesMenu).
     */
    // GIVEN an arbitrary conversation list AND a footer action
    const conversations = [
      makeConversation({ conversationKey: "a", title: "Alpha" }),
    ];

    // WHEN we render with includeFooterAction (default true — emits a
    // sentinel containing the "Preferences" label)
    const html = renderMenu({ conversations });

    // THEN the sentinel content is in the markup
    expect(html).toContain("Preferences");
  });

  test("omits the footer entirely when `footerAction` is undefined", () => {
    /**
     * Leaving `footerAction` undefined drops the whole SideMenu.Footer —
     * no stray separator or ghost row.
     */
    // GIVEN a conversation list AND no footer action
    const conversations = [
      makeConversation({ conversationKey: "a", title: "Alpha" }),
    ];

    // WHEN we render without a footer action
    const html = renderMenu({ conversations, includeFooterAction: false });

    // THEN the sentinel content is absent
    expect(html).not.toContain("Preferences");
  });
});

// ---------------------------------------------------------------------------
// Overlay (mobile) close affordance — the X lives at the top-right of the
// side menu (overlay variant only). The drawer covers the full viewport
// so the top bar is hidden behind it; the X is the user's only dismissal
// affordance besides Escape.
// ---------------------------------------------------------------------------

describe("AssistantSideMenu · overlay close affordance", () => {
  test("renders an X close button on overlay variant only", () => {
    const conversations = [
      makeConversation({ conversationKey: "a", title: "Alpha" }),
    ];
    const overlayHtml = renderMenu({ conversations, variant: "overlay" });
    const railHtml = renderMenu({ conversations, variant: "rail" });
    expect(overlayHtml).toContain('aria-label="Close navigation"');
    expect(railHtml).not.toContain('aria-label="Close navigation"');
  });
});

// ---------------------------------------------------------------------------
// Mobile drawer auto-close on new conversation — source-surface assertion.
//
// The interactive test environment does not support DOM mounting, so we pin
// the wiring via a source read. The "New conversation" compose button must
// call `onClose?.()` alongside `onStartNewConversation()` so the mobile
// overlay drawer collapses as soon as the user taps it — matching the
// existing behaviour of the other nav actions (intelligence, library, app,
// select conversation) which all already invoke `onClose?.()`.
// ---------------------------------------------------------------------------

describe("AssistantSideMenu · compose button mobile close wiring", () => {
  test("compose button onClick calls onClose alongside onStartNewConversation", () => {
    const src = readFileSync(
      new URL("./AssistantSideMenu.tsx", import.meta.url).pathname,
      "utf8",
    );

    // The button's onClick must fan-out to both callbacks.
    // We assert the exact two-call pattern rather than a substring of the
    // handler text so a naive "passes onStartNewConversation unchanged"
    // regression would be caught (that form does not call onClose).
    expect(src).toContain("onStartNewConversation(); onClose?.();");
  });
});
