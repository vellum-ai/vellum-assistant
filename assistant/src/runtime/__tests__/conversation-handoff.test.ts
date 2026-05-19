import { describe, expect, test } from "bun:test";

import { resolveDefaultConversationKey } from "../conversation-handoff.js";

describe("resolveDefaultConversationKey", () => {
  test("uses shared handoff key for local first-party vellum interfaces", () => {
    expect(resolveDefaultConversationKey("vellum", "macos")).toBe(
      "default:vellum:handoff",
    );
    expect(resolveDefaultConversationKey("vellum", "ios")).toBe(
      "default:vellum:handoff",
    );
    expect(resolveDefaultConversationKey("vellum", "chrome-extension")).toBe(
      "default:vellum:handoff",
    );
  });

  test("keeps interface-scoped defaults for non-local channels", () => {
    expect(resolveDefaultConversationKey("slack", "slack")).toBe(
      "default:slack:slack",
    );
    expect(resolveDefaultConversationKey("telegram", "telegram")).toBe(
      "default:telegram:telegram",
    );
  });

  test("does not merge CLI into the shared handoff key", () => {
    expect(resolveDefaultConversationKey("vellum", "cli")).toBe(
      "default:vellum:cli",
    );
  });
});
