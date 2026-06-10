import { expect, test } from "bun:test";

import type { MemoryRoutingTurn, SelectionSource, Slug } from "../types.js";

test("v3 core types instantiate", () => {
  const slug: Slug = "page-123";

  const turnContext: MemoryRoutingTurn = {
    conversationId: "conv-xyz",
    turnNumber: 3,
    currentMessage: "hello",
    recentContext: "prior turns",
  };

  const source: SelectionSource = "needle";

  expect(slug).toBe("page-123");
  expect(turnContext.turnNumber).toBe(3);
  expect(source).toBe("needle");
});
