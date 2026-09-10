import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { supportsScopedSubagentStatus } from "@/lib/backwards-compat/subagent-status-conversation-id";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function readGate(version: string | null): boolean {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
  return supportsScopedSubagentStatus();
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

// Exhaustive semver truth-table lives in `utils.test.ts`. Here we verify the
// boundary on each side of MIN_VERSION (0.11.12, the lowest assistant version
// whose `subagent_status_changed` names the parent conversation) plus the
// conservative-on-unknown policy.
describe("supportsScopedSubagentStatus", () => {
  test("reads false when the version is unknown", () => {
    expect(readGate(null)).toBe(false);
  });

  test("reads false below 0.11.12", () => {
    expect(readGate("0.11.11")).toBe(false);
    expect(readGate("0.11.7")).toBe(false);
    expect(readGate("0.10.12")).toBe(false);
  });

  test("reads false for a dev build of a base below 0.11.12", () => {
    expect(readGate("0.11.11-dev.202609100000.abcdef0")).toBe(false);
  });

  test("reads true at 0.11.12 and for its dev builds", () => {
    expect(readGate("0.11.12")).toBe(true);
    expect(readGate("0.11.12-dev.202609200000.abcdef0")).toBe(true);
  });

  test("reads true for later releases", () => {
    expect(readGate("0.11.13")).toBe(true);
    expect(readGate("0.12.0")).toBe(true);
    expect(readGate("1.0.0")).toBe(true);
  });

  test("reads false for unparseable versions", () => {
    expect(readGate("garbage")).toBe(false);
    expect(readGate("0.11")).toBe(false);
  });
});
