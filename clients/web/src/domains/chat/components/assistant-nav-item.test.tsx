/**
 * Tests for `AssistantNavItem`'s leading slot: which avatar the sidebar's
 * identity row wears.
 *
 * Rendered with `renderToStaticMarkup`, so no effects run and the blink loop
 * stays out of it. What is under test is the branch that picks the slot's
 * contents, which is pure.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { AssistantNavItem } from "@/domains/chat/components/assistant-nav-item";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

/* The hook reads through React Query, which static rendering has no client
   for. Mocked through a mutable value rather than a fixed one: a module mock
   is per-file, and these cases differ only by what the hook resolves. */
interface AvatarState {
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
}

let avatar: AvatarState = {
  components: null,
  traits: null,
  customImageUrl: null,
};

mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: () => ({
    ...avatar,
    isLoading: false,
    invalidate: () => {},
  }),
}));

const IMAGE = "blob:http://localhost/abc-123";

function renderRow(collapsed = false): string {
  return renderToStaticMarkup(
    createElement(AssistantNavItem, {
      assistantId: "a1",
      label: "Haze II",
      active: false,
      collapsed,
      onSelect: () => {},
    }),
  );
}

/** How many times the uploaded image is painted in the row. */
function imageCount(html: string): number {
  return html.split(`src="${IMAGE}"`).length - 1;
}

describe("AssistantNavItem leading slot", () => {
  beforeEach(() => {
    avatar = { components: null, traits: null, customImageUrl: null };
  });

  test("an uploaded image takes the slot instead of the Brain", () => {
    avatar = { components: null, traits: null, customImageUrl: IMAGE };
    const html = renderRow();
    /* Exactly one: the row draws one avatar, and a slot that renders both the
       image and the glyph it stands in for is the failure this guards. */
    expect(imageCount(html)).toBe(1);
    expect(html).not.toContain("lucide-brain");
  });

  test("the collapsed tile wears the image too", () => {
    avatar = { components: null, traits: null, customImageUrl: IMAGE };
    const html = renderRow(true);
    expect(imageCount(html)).toBe(1);
    expect(html).not.toContain("lucide-brain");
  });

  test("no avatar at all still falls back to the Brain", () => {
    const html = renderRow();
    expect(html).toContain("lucide-brain");
    expect(imageCount(html)).toBe(0);
  });

  test("the collapsed tile falls back to the Brain too", () => {
    const html = renderRow(true);
    expect(html).toContain("lucide-brain");
    expect(imageCount(html)).toBe(0);
  });

  /* A character avatar owns the slot with its eyes, and an assistant can hold
     both a character and a stale image blob. The character wins, and the image
     must not be painted underneath or beside it. */
  test("a character avatar keeps its eyes, even with an image present", () => {
    avatar = {
      components: BUNDLED_COMPONENTS,
      traits: { bodyShape: "blob", eyeStyle: "curious", color: "purple" },
      customImageUrl: IMAGE,
    };
    const html = renderRow();
    expect(imageCount(html)).toBe(0);
    expect(html).not.toContain("lucide-brain");
    // The eyes render as inline SVG paths in the slot.
    expect(html).toContain("<svg");
  });
});

describe("AssistantNavItem switcher slots", () => {
  const TRAILING = createElement(
    "span",
    { "data-testid": "switcher-chevron" },
    "v",
  );
  const EXPANSION = createElement(
    "div",
    { "data-testid": "switcher-card" },
    "card",
  );

  function renderWithSlots(
    props: Partial<Parameters<typeof AssistantNavItem>[0]> = {},
  ): string {
    return renderToStaticMarkup(
      createElement(AssistantNavItem, {
        assistantId: "a1",
        label: "Haze II",
        active: false,
        onSelect: () => {},
        onNewConversation: () => {},
        ...props,
      }),
    );
  }

  test("a trailing action renders inside the expanded pill", () => {
    const html = renderWithSlots({ trailingAction: TRAILING });
    expect(html).toContain('data-testid="switcher-chevron"');
    expect(html).toContain("gap-[12px]");
  });

  test("without a trailing action the pill keeps its default gap", () => {
    const html = renderWithSlots();
    expect(html).not.toContain("gap-[12px]");
  });

  test("the collapsed tile has no slot for the trailing action", () => {
    const html = renderWithSlots({ trailingAction: TRAILING, collapsed: true });
    expect(html).not.toContain('data-testid="switcher-chevron"');
  });

  test("an expansion replaces the pill and keeps the New Chat row", () => {
    const html = renderWithSlots({ expansion: EXPANSION });
    expect(html).toContain('data-testid="switcher-card"');
    expect(html).not.toContain('data-tour-id="assistant-page"');
    expect(html).toContain(">New Chat<");
  });

  test("the collapsed tile ignores an expansion", () => {
    const html = renderWithSlots({ expansion: EXPANSION, collapsed: true });
    expect(html).not.toContain('data-testid="switcher-card"');
    expect(html).toContain('data-tour-id="assistant-page"');
  });
});

describe("AssistantNavItem New Chat shortcut tooltip", () => {
  function renderNewChat(collapsed = false): string {
    return renderToStaticMarkup(
      createElement(AssistantNavItem, {
        assistantId: "a1",
        label: "Haze II",
        active: false,
        collapsed,
        onSelect: () => {},
        onNewConversation: () => {},
      }),
    );
  }

  test("the expanded row keeps its New Chat label", () => {
    const html = renderNewChat();
    expect(html).toContain(">New Chat<");
  });

  test("the collapsed tile is named New Chat without a native title", () => {
    const html = renderNewChat(true);
    expect(html).toContain('aria-label="New Chat"');
    expect(html).not.toContain('title="New Chat"');
  });
});
