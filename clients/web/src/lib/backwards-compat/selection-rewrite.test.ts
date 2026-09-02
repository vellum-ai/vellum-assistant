import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { supportsSelectionRewrite } from "@/lib/backwards-compat/selection-rewrite";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const ASSISTANT_ID = "asst-hold";

function readGate(
  version: string | null,
  identityAssistantId: string | null = ASSISTANT_ID,
): boolean {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, identityAssistantId);
  return supportsSelectionRewrite(ASSISTANT_ID);
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

// The version semantics live in `utils.test.ts`. This checks each side of
// MIN_VERSION through the exported gate, plus that a version fetched for
// another assistant does not light the lane up for this one.
describe("supportsSelectionRewrite", () => {
  test("reads false for 0.11.8 stable and builds before the commit", () => {
    expect(readGate("0.11.8")).toBe(false);
    expect(readGate("0.11.8-dev.202609021400.abc1234")).toBe(false);
    expect(readGate("0.11.8-local.20260902140000.abc1234")).toBe(false);
    expect(readGate(null)).toBe(false);
  });

  test("reads true from the commit's build on, and from 0.11.9", () => {
    expect(readGate("0.11.8-dev.202609021456.e7361b7")).toBe(true);
    expect(readGate("0.11.8-local.20260902160000.abc1234")).toBe(true);
    expect(readGate("0.11.9")).toBe(true);
    expect(readGate("0.12.0")).toBe(true);
  });

  test("reads false when the version belongs to a different assistant", () => {
    expect(readGate("0.11.9", "asst-other")).toBe(false);
  });
});
