import { describe, expect, test } from "bun:test";

import {
  buildDragProps,
  buildMenuProps,
} from "@/domains/chat/components/conversation-row";
import type { ConversationListContextValue } from "@/domains/chat/components/conversation-list-context";
import type { UseDragReorderResult } from "@/domains/chat/hooks/use-drag-reorder";
import type { Conversation } from "@/types/conversation-types";

const stubDragReorder: UseDragReorderResult<Conversation> = {
  getItemProps: () => ({
    draggable: true,
    onDragStart: () => {},
    onDragOver: () => {},
    onDragLeave: () => {},
    onDrop: () => {},
    onDragEnd: () => {},
  }),
  draggingId: null,
  dropIndicator: null,
};

function makeCtx(
  overrides: Partial<ConversationListContextValue> = {},
): ConversationListContextValue {
  return {
    onSelect: () => {},
    dragReorder: stubDragReorder,
    canReorder: false,
    ...overrides,
  };
}

function conv(overrides: Partial<Conversation> = {}): Conversation {
  return { conversationId: overrides.conversationId ?? "c1", ...overrides };
}

describe("buildMenuProps", () => {
  test("marks channel conversations read-only and omits analyze", () => {
    const props = buildMenuProps(
      makeCtx({ onAnalyze: () => {} }),
      conv({ originChannel: "telegram" }),
    );
    expect(props.isReadonly).toBe(true);
    expect(props.onAnalyze).toBeUndefined();
  });

  test("wires analyze for native conversations", () => {
    const props = buildMenuProps(
      makeCtx({ onAnalyze: () => {} }),
      conv({ originChannel: "vellum" }),
    );
    expect(props.isReadonly).toBe(false);
    expect(typeof props.onAnalyze).toBe("function");
  });

  test("only wires callbacks the context provides", () => {
    const bare = buildMenuProps(makeCtx(), conv());
    expect(bare.onRename).toBeUndefined();
    expect(bare.onArchive).toBeUndefined();

    const wired = buildMenuProps(
      makeCtx({ onRename: () => {}, onArchive: () => {} }),
      conv(),
    );
    expect(typeof wired.onRename).toBe("function");
    expect(typeof wired.onArchive).toBe("function");
  });

  test("offers mark-read for unread rows and mark-unread for read rows", () => {
    const ctx = makeCtx({ onMarkRead: () => {}, onMarkUnread: () => {} });

    const unread = buildMenuProps(
      ctx,
      conv({ hasUnseenLatestAssistantMessage: true }),
    );
    expect(typeof unread.onMarkRead).toBe("function");
    expect(unread.onMarkUnread).toBeUndefined();

    const read = buildMenuProps(
      ctx,
      conv({ hasUnseenLatestAssistantMessage: false }),
    );
    expect(read.onMarkRead).toBeUndefined();
    expect(typeof read.onMarkUnread).toBe("function");
  });
});

describe("buildDragProps", () => {
  const a = conv({ conversationId: "a" });
  const b = conv({ conversationId: "b" });

  test("returns nothing when reordering is disabled", () => {
    expect(buildDragProps(makeCtx({ canReorder: false }), a, "pinned", [a, b])).toEqual(
      {},
    );
  });

  test("returns nothing without a section or with fewer than two siblings", () => {
    const ctx = makeCtx({ canReorder: true });
    expect(buildDragProps(ctx, a, undefined, [a, b])).toEqual({});
    expect(buildDragProps(ctx, a, "pinned", [a])).toEqual({});
  });

  test("dims the row currently being dragged", () => {
    const ctx = makeCtx({
      canReorder: true,
      dragReorder: { ...stubDragReorder, draggingId: "a" },
    });
    const props = buildDragProps(ctx, a, "pinned", [a, b]);
    expect(props.draggable).toBe(true);
    expect(props.className).toContain("opacity-50");
  });

  test("draws the drop line on the hovered edge within the same section", () => {
    const ctx = makeCtx({
      canReorder: true,
      dragReorder: {
        ...stubDragReorder,
        dropIndicator: { section: "pinned", itemId: "b", edge: "before" },
      },
    });
    const props = buildDragProps(ctx, b, "pinned", [a, b]);
    expect(props.className).toContain(
      "shadow-[inset_0_2px_0_0_var(--primary-base)]",
    );
  });

  test("ignores a drop indicator from another section", () => {
    const ctx = makeCtx({
      canReorder: true,
      dragReorder: {
        ...stubDragReorder,
        dropIndicator: { section: "group:x", itemId: "b", edge: "after" },
      },
    });
    const props = buildDragProps(ctx, b, "pinned", [a, b]);
    expect(props.className).not.toContain("shadow-");
  });
});
