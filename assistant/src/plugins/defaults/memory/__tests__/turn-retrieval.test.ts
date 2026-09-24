import { expect, test } from "bun:test";

import { shouldRetrieveTurnMemory } from "../turn-retrieval.js";

test("fresh retrieval defaults on, except for front-door and explicitly skipped turns", () => {
  expect(shouldRetrieveTurnMemory({})).toBe(true);
  expect(shouldRetrieveTurnMemory({ callSite: "callAgent" })).toBe(true);
  expect(shouldRetrieveTurnMemory({ callSite: "voiceFrontDoor" })).toBe(false);
  expect(
    shouldRetrieveTurnMemory({
      callSite: "callAgent",
      skipMemoryRetrieval: true,
    }),
  ).toBe(false);
  expect(
    shouldRetrieveTurnMemory({
      callSite: "callAgent",
      skipMemoryRetrieval: false,
    }),
  ).toBe(true);
});
