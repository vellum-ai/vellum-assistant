/**
 * Tests for the composer's placeholder policy.
 *
 * The regression these pin is the empty state changing its own copy while
 * it loads: the assistant name lands after the first paint, and letting it
 * rewrite the placeholder swaps the prompt under the reader mid-load.
 */

import { describe, expect, test } from "bun:test";

import { resolveComposerPlaceholder } from "@/domains/chat/utils/composer-placeholder";

const EMPTY = "What should we tackle?";
const NAMED = "Ask Luna";
const DEFAULT = "What would you like to do?";

function resolve(
  overrides: Partial<Parameters<typeof resolveComposerPlaceholder>[0]> = {},
) {
  return resolveComposerPlaceholder({
    isEmptyConversation: true,
    emptyStatePlaceholder: EMPTY,
    assistantPlaceholder: null,
    defaultPlaceholder: DEFAULT,
    ...overrides,
  });
}

describe("resolveComposerPlaceholder", () => {
  test("a fresh conversation shows the neutral prompt", () => {
    expect(resolve()).toBe(EMPTY);
  });

  test("the assistant name arriving does not rewrite a fresh conversation's prompt", () => {
    // The name resolves from a query that settles after the first paint. The
    // same input before and after it lands must produce the same copy.
    expect(resolve({ assistantPlaceholder: null })).toBe(EMPTY);
    expect(resolve({ assistantPlaceholder: NAMED })).toBe(EMPTY);
  });

  test("an active conversation on a narrow composer names the assistant", () => {
    expect(
      resolve({ isEmptyConversation: false, assistantPlaceholder: NAMED }),
    ).toBe(NAMED);
  });

  test("an active conversation without a name keeps the wider copy", () => {
    expect(
      resolve({ isEmptyConversation: false, assistantPlaceholder: null }),
    ).toBe(DEFAULT);
  });
});
