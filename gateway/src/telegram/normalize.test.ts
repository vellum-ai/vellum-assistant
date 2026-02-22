import { describe, it, expect } from "bun:test";
import { normalizeTelegramUpdate } from "./normalize.js";

function makeCallbackQueryPayload(overrides?: {
  chatType?: string;
  chatId?: number;
  data?: string;
  fromId?: number;
}) {
  const hasChatType = overrides !== undefined && "chatType" in overrides;
  return {
    update_id: 100,
    callback_query: {
      id: "cbq-1",
      from: { id: overrides?.fromId ?? 42, first_name: "Alice" },
      message: {
        message_id: 10,
        chat: {
          id: overrides?.chatId ?? 42,
          type: hasChatType ? overrides!.chatType : "private",
        },
      },
      data: overrides?.data ?? "apr:run1:approve",
    },
  };
}

describe("normalizeTelegramUpdate — callback_query DM-only guard", () => {
  it("accepts callback_query from private chat", () => {
    const result = normalizeTelegramUpdate(
      makeCallbackQueryPayload({ chatType: "private" }),
    );
    expect(result).not.toBeNull();
    expect(result!.message.callbackQueryId).toBe("cbq-1");
    expect(result!.message.callbackData).toBe("apr:run1:approve");
  });

  it("rejects callback_query from group chat", () => {
    const result = normalizeTelegramUpdate(
      makeCallbackQueryPayload({ chatType: "group" }),
    );
    expect(result).toBeNull();
  });

  it("rejects callback_query from supergroup chat", () => {
    const result = normalizeTelegramUpdate(
      makeCallbackQueryPayload({ chatType: "supergroup" }),
    );
    expect(result).toBeNull();
  });

  it("rejects callback_query from channel chat", () => {
    const result = normalizeTelegramUpdate(
      makeCallbackQueryPayload({ chatType: "channel" }),
    );
    expect(result).toBeNull();
  });

  it("rejects callback_query when chat type is undefined", () => {
    const result = normalizeTelegramUpdate(
      makeCallbackQueryPayload({ chatType: undefined as unknown as string }),
    );
    expect(result).toBeNull();
  });
});
