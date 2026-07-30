import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { supportsSubagentDetailSelfLookup } from "@/lib/backwards-compat/subagent-detail-self-lookup";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function setVersion(version: string | null) {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

// Exhaustive truth-table for the underlying semver gate lives in
// `utils.test.ts`. Here we verify each side of the 0.11.1 boundary, and
// specifically that 0.11.0 stays off: it self-resolves from live manager
// state only, so an evicted subagent still falls through to the caller's id
// and the daemon would parse the parent conversation as the child's.
describe("supportsSubagentDetailSelfLookup", () => {
  test("false when version is unknown", () => {
    setVersion(null);
    expect(supportsSubagentDetailSelfLookup()).toBe(false);
  });

  test("false on 0.11.0, whose self-lookup misses evicted subagents", () => {
    setVersion("0.11.0");
    expect(supportsSubagentDetailSelfLookup()).toBe(false);
  });

  test("true for assistants on 0.11.1+", () => {
    setVersion("0.11.1");
    expect(supportsSubagentDetailSelfLookup()).toBe(true);
  });

  test("true for RC builds of the cutover patch", () => {
    setVersion("0.11.1-rc.1");
    expect(supportsSubagentDetailSelfLookup()).toBe(true);
  });

  test("true for later minors", () => {
    setVersion("0.12.0");
    expect(supportsSubagentDetailSelfLookup()).toBe(true);
  });
});
