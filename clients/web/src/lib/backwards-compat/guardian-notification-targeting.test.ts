import { afterEach, describe, expect, test } from "bun:test";

import { supportsGuardianNotificationTargeting } from "@/lib/backwards-compat/guardian-notification-targeting";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

// The semver truth table lives in `utils.test.ts`. These pin the boundary,
// the conservative unknown-version answer, and the assistant scoping.
describe("supportsGuardianNotificationTargeting", () => {
  test("is false while the version is unknown", () => {
    expect(supportsGuardianNotificationTargeting("asst-1")).toBe(false);
  });

  test("is false for an assistant older than the targeting", () => {
    useAssistantIdentityStore.getState().setIdentity("Test", "0.12.2", "asst-1");
    expect(supportsGuardianNotificationTargeting("asst-1")).toBe(false);
  });

  test("is true for an assistant that targets the guardian's connections", () => {
    useAssistantIdentityStore.getState().setIdentity("Test", "0.12.3", "asst-1");
    expect(supportsGuardianNotificationTargeting("asst-1")).toBe(true);
    useAssistantIdentityStore.getState().setIdentity("Test", "0.13.0", "asst-1");
    expect(supportsGuardianNotificationTargeting("asst-1")).toBe(true);
  });

  test("is false when the known version belongs to a different assistant", () => {
    useAssistantIdentityStore.getState().setIdentity("Test", "0.13.0", "asst-2");
    expect(supportsGuardianNotificationTargeting("asst-1")).toBe(false);
  });
});
