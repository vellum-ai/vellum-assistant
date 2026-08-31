import { describe, expect, test } from "bun:test";

import { DRAWER_SURFACE_BACKGROUND } from "@/domains/chat/utils/drawer-surface";

describe("DRAWER_SURFACE_BACKGROUND", () => {
  test("paints a fully opaque surface token", () => {
    // The drawer covers the chat; nothing behind it may bleed through.
    expect(DRAWER_SURFACE_BACKGROUND).toBe("var(--surface-base)");
  });
});
