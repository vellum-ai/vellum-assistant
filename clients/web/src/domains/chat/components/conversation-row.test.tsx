import { describe, expect, test } from "bun:test";

import { buildMenuProps } from "@/domains/chat/components/conversation-row";
import type { ConversationListContextValue } from "@/domains/chat/components/conversation-list-context";
import type { Conversation } from "@/types/conversation-types";

function makeCtx(
  overrides: Partial<ConversationListContextValue> = {},
): ConversationListContextValue {
  return {
    onSelect: () => {},
    ...overrides,
  };
}

function conv(overrides: Partial<Conversation> = {}): Conversation {
  return { conversationId: overrides.conversationId ?? "c1", ...overrides };
}

describe("buildMenuProps", () => {
  test("marks channel conversations read-only", () => {
    const channel = buildMenuProps(
      makeCtx(),
      conv({ originChannel: "telegram" }),
    );
    expect(channel.isReadonly).toBe(true);

    const native = buildMenuProps(makeCtx(), conv({ originChannel: "vellum" }));
    expect(native.isReadonly).toBe(false);
  });

  test("only wires callbacks the context provides", () => {
    const bare = buildMenuProps(makeCtx(), conv());
    expect(bare.onRename).toBeUndefined();
    expect(bare.onArchive).toBeUndefined();
    expect(bare.onDelete).toBeUndefined();

    const wired = buildMenuProps(
      makeCtx({
        onRename: () => {},
        onArchive: () => {},
        onDelete: () => {},
      }),
      conv(),
    );
    expect(typeof wired.onRename).toBe("function");
    expect(typeof wired.onArchive).toBe("function");
    expect(typeof wired.onDelete).toBe("function");
  });

  test("does not wire delete for unresolved draft conversations", () => {
    const wired = buildMenuProps(
      makeCtx({ onDelete: () => {} }),
      conv({ draft: true }),
    );
    expect(wired.onDelete).toBeUndefined();
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
