/**
 * The load-more seam of `ConversationRowList`: `onEndReached` present means
 * a windowed list, and a windowed list carries a sentinel that pages more
 * in when scrolled to; absent means the list is complete and must not.
 *
 * Asserted at the DOM through the sentinel's `data-slot`, on the
 * direct-render path (rows under the virtualize threshold), where the
 * sentinel is the trigger. The virtualized path wires the same callback to
 * `VirtualList.endReached` and needs no DOM sentinel.
 */

import { render } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";

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
        items: ROWS,
        onEndReached,
        isLast: extras?.isLast,
      }),
    ),
  );
  return container;
}

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
