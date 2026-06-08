import { expect, test } from "bun:test";

import type {
  MemoryRoutingTurn,
  SelectionSource,
  Slug,
  WorkingSetEntry,
} from "../types.js";

test("v3 core types instantiate", () => {
  const slug: Slug = "page-123";

  const entry: WorkingSetEntry = {
    slug,
    selectedAtTurn: 1,
    pinned: false,
    lastSeenTurn: 2,
  };

  const turnContext: MemoryRoutingTurn = {
    conversationId: "conv-xyz",
    turnNumber: 3,
    currentMessage: "hello",
    recentContext: "prior turns",
  };

  const source: SelectionSource = "carry-forward";

  expect(entry.slug).toBe(slug);
  expect(turnContext.turnNumber).toBe(3);
  expect(source).toBe("carry-forward");
});
