import { describe, expect, test } from "bun:test";

import { resolveChatConnectingReason } from "@/domains/chat/utils/connecting-reason";

describe("resolveChatConnectingReason", () => {
  test("prioritizes auth loading", () => {
    expect(
      resolveChatConnectingReason({
        authLoading: true,
        assistantStateKind: "loading",
        autoGreetPending: true,
      }),
    ).toBe("auth_loading");
  });

  test("reports assistant lifecycle loading before auto-greet pending", () => {
    expect(
      resolveChatConnectingReason({
        authLoading: false,
        assistantStateKind: "loading",
        autoGreetPending: true,
      }),
    ).toBe("assistant_loading");
  });

  test("reports auto-greet pending when lifecycle is otherwise ready", () => {
    expect(
      resolveChatConnectingReason({
        authLoading: false,
        assistantStateKind: "active",
        autoGreetPending: true,
      }),
    ).toBe("auto_greet_pending");
  });

  test("returns null when chat can render", () => {
    expect(
      resolveChatConnectingReason({
        authLoading: false,
        assistantStateKind: "active",
        autoGreetPending: false,
      }),
    ).toBeNull();
  });
});
