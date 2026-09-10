import { describe, expect, test } from "bun:test";

import {
  isSilentToolCall,
  isUiSurfaceToolCall,
} from "@/domains/chat/utils/silent-tool-calls";

describe("isSilentToolCall", () => {
  test("matches the bookkeeping tools", () => {
    for (const name of [
      "send_user_message",
      "remember",
      "recall",
      "delete_memory_page",
      "notify_parent",
      "subagent_message",
      "skill_load",
      "followup_create",
      "followup_resolve",
    ]) {
      expect(isSilentToolCall({ name })).toBe(true);
    }
  });

  test("matches the surface tools, unless one is awaiting a confirmation", () => {
    for (const name of ["ui_show", "ui_update", "ui_dismiss"]) {
      expect(isSilentToolCall({ name })).toBe(true);
      expect(
        isSilentToolCall({ name, pendingConfirmation: { requestId: "req-1" } }),
      ).toBe(false);
    }
  });

  test("leaves work the user asked for visible", () => {
    // Side effects, waits, and spawns all draw a step of their own. A pending
    // confirmation never rescues a bookkeeping tool, which has no chip to hang
    // one on.
    for (const name of [
      "bash",
      "web_fetch",
      "file_write",
      "messaging_send",
      "subagent_spawn",
      "schedule_create",
      "ask_question",
    ]) {
      expect(isSilentToolCall({ name })).toBe(false);
    }
    expect(
      isSilentToolCall({
        name: "remember",
        pendingConfirmation: { requestId: "req-1" },
      }),
    ).toBe(true);
  });
});

describe("isUiSurfaceToolCall", () => {
  test("covers only the three surface tools", () => {
    expect(isUiSurfaceToolCall({ name: "ui_show" })).toBe(true);
    expect(isUiSurfaceToolCall({ name: "remember" })).toBe(false);
    expect(isUiSurfaceToolCall({ name: "bash" })).toBe(false);
  });
});
