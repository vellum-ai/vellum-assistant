import { describe, expect, test } from "bun:test";

import { cachedTextBlock } from "../provider-blocks.js";

describe("cachedTextBlock", () => {
  test("stamps an ephemeral cache_control with a 1h TTL", () => {
    const block = cachedTextBlock("stable leaf block");
    expect(block).toMatchObject({ type: "text", text: "stable leaf block" });
    expect(
      (block as unknown as { cache_control?: unknown }).cache_control,
    ).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});
