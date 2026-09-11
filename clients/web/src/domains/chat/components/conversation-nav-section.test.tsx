/**
 * The load-more seam of `ConversationRowList`: `onEndReached` present means
 * a windowed list, and a windowed list carries a sentinel that pages more
 * in when scrolled to; absent means the list is complete and must not.
 *
 * Asserted at the DOM through the sentinel's `data-slot`, on the
 * direct-render path (rows under the virtualize threshold), where the
 * sentinel is the trigger. The virtualized path wires the same callback to
 * `VirtualList.endReached` and needs no DOM sentinel.
 *
 * The expand seam (`expandable`) is asserted the same way: when the Expand
 * control mounts, which height the scroller takes, and what a click asks
 * the owner for.
 */

import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";

import { SIDEBAR_SECTION_MAX_HEIGHT } from "@/components/sidebar-nav-geometry";
import type * as ConversationRowModule from "@/domains/chat/components/conversation-row";
import { ConversationListProvider } from "@/domains/chat/components/conversation-list-context";
import type { Conversation } from "@/types/conversation-types";

/* Row rendering is not under test; a stub keeps this on the seam. Typed
   against the real module, and spread over it, so the stub replaces only
   the row and a module that grows an export still fails the build here. */
const actualRow = await import("@/domains/chat/components/conversation-row");
mock.module(
  "@/domains/chat/components/conversation-row",
  (): typeof ConversationRowModule => ({
    ...actualRow,
    ConversationRow: ({ conversation }) =>
      createElement("div", { "data-testid": "row" }, conversation.title),
  }),
);

const { ConversationRowList } =
  await import("@/domains/chat/components/conversation-nav-section");

const ROWS: Conversation[] = [
  { conversationId: "c1", title: "One" },
  { conversationId: "c2", title: "Two" },
];

function renderList(
  onEndReached?: () => void,
  extras?: {
    overlayCards?: boolean;
    isLast?: boolean;
    items?: Conversation[];
    unbounded?: boolean;
    expandable?: boolean;
    expanded?: boolean;
    onExpandedChange?: (expanded: boolean) => void;
  },
) {
  const { container } = render(
    createElement(
      ConversationListProvider,
      {
        value: {
          onSelect: () => {},
          overlayCards: extras?.overlayCards,
        },
      },
      createElement(ConversationRowList, {
        items: extras?.items ?? ROWS,
        onEndReached,
        isLast: extras?.isLast,
        unbounded: extras?.unbounded,
        expandable: extras?.expandable,
        expanded: extras?.expanded,
        onExpandedChange: extras?.onExpandedChange,
      }),
    ),
  );
  return container;
}

const rowsIn = (container: HTMLElement) =>
  container.querySelectorAll('[data-testid="row"]');
const expandButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>(
    '[data-slot="sidebar-expand-row"] button',
  );
const scrollerOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(".overflow-y-auto");

/** Twenty-five rows: past the mid-height cap, short of the virtualize cut. */
const MANY_ROWS: Conversation[] = Array.from({ length: 25 }, (_, index) => ({
  conversationId: `m${index + 1}`,
  title: `Thread ${index + 1}`,
}));

afterEach(() => {
  mock.restore();
});

describe("ConversationRowList load-more seam", () => {
  test("a windowed list carries a load-more sentinel after its rows", () => {
    const container = renderList(() => {});

    expect(container.querySelectorAll('[data-testid="row"]')).toHaveLength(2);
    expect(
      container.querySelectorAll('[data-slot="load-more-sentinel"]'),
    ).toHaveLength(1);
  });

  test("a complete list carries no sentinel", () => {
    const container = renderList(undefined);

    expect(container.querySelectorAll('[data-testid="row"]')).toHaveLength(2);
    expect(
      container.querySelectorAll('[data-slot="load-more-sentinel"]'),
    ).toHaveLength(0);
  });
});

describe("ConversationRowList overlay scroll", () => {
  test("overlay cards grow with the drawer body instead of nesting a scroller", () => {
    const container = renderList(undefined, {
      overlayCards: true,
      isLast: true,
    });

    expect(container.querySelector(".overflow-y-auto")).toBeNull();
    expect(container.querySelectorAll('[data-testid="row"]')).toHaveLength(2);
  });

  test("a rail last-section still owns an inner scroller", () => {
    const container = renderList(undefined, { isLast: true });

    expect(container.querySelector(".overflow-y-auto")).not.toBeNull();
  });
});

describe("ConversationRowList expand", () => {
  test("an expandable last section rests at the cap and offers Expand", () => {
    const container = renderList(undefined, {
      items: MANY_ROWS,
      isLast: true,
      expandable: true,
    });

    expect(rowsIn(container)).toHaveLength(25);
    expect(scrollerOf(container)?.style.maxHeight).toBe(
      `${SIDEBAR_SECTION_MAX_HEIGHT}px`,
    );
    const button = expandButton(container);
    expect(button?.textContent).toBe("Expand");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
  });

  test("expanded, the scroller drops its cap and the control offers Collapse", () => {
    const container = renderList(undefined, {
      items: MANY_ROWS,
      isLast: true,
      expandable: true,
      expanded: true,
    });

    expect(scrollerOf(container)?.style.maxHeight).toBe("");
    const button = expandButton(container);
    expect(button?.textContent).toBe("Collapse");
    expect(button?.getAttribute("aria-expanded")).toBe("true");
  });

  test("the control asks its owner for the opposite state", () => {
    const onExpandedChange = mock((_expanded: boolean) => {});
    const container = renderList(undefined, {
      items: MANY_ROWS,
      isLast: true,
      expandable: true,
      onExpandedChange,
    });

    fireEvent.click(expandButton(container)!);
    expect(onExpandedChange).toHaveBeenCalledWith(true);
  });

  test("a section within its cap has nothing to expand", () => {
    const container = renderList(undefined, {
      isLast: true,
      expandable: true,
    });

    expect(expandButton(container)).toBeNull();
    expect(scrollerOf(container)?.style.maxHeight).toBe(
      `${SIDEBAR_SECTION_MAX_HEIGHT}px`,
    );
  });

  test("a short section paging from the server still offers Expand", () => {
    const container = renderList(() => {}, {
      isLast: true,
      expandable: true,
    });

    expect(expandButton(container)).not.toBeNull();
  });

  test("the control belongs to the rail's last section only", () => {
    expect(
      expandButton(
        renderList(undefined, { items: MANY_ROWS, expandable: true }),
      ),
    ).toBeNull();
    expect(
      expandButton(
        renderList(undefined, {
          items: MANY_ROWS,
          isLast: true,
          expandable: true,
          overlayCards: true,
        }),
      ),
    ).toBeNull();
    expect(
      expandButton(
        renderList(undefined, {
          items: MANY_ROWS,
          isLast: true,
          expandable: true,
          unbounded: true,
        }),
      ),
    ).toBeNull();
  });

  test("a last section that is not expandable takes no cap", () => {
    const container = renderList(undefined, {
      items: MANY_ROWS,
      isLast: true,
    });

    expect(expandButton(container)).toBeNull();
    expect(scrollerOf(container)?.style.maxHeight).toBe("");
  });
});
