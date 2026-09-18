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
    for (const version of ["0.12.1", "0.12.2", "0.12.2-dev.202609181818.66f51a7"]) {
      useAssistantIdentityStore.getState().setIdentity("Test", version, "asst-1");
      expect(supportsGuardianNotificationTargeting("asst-1")).toBe(false);
    }
  });

  test("is true for an assistant that targets the guardian's connections", () => {
    for (const version of [
      "0.12.2-dev.202609181913.1108ac3",
      "0.12.2-dev.202609190013.abcdef1",
      "0.12.3",
      "0.13.0",
    ]) {
      useAssistantIdentityStore.getState().setIdentity("Test", version, "asst-1");
      expect(supportsGuardianNotificationTargeting("asst-1")).toBe(true);
    }
  });

  test("is false for a local build, whatever its stamp", () => {
    for (const version of [
      "0.12.2-local.20260916144827.abcdef1",
      "0.12.2-local.20260918200000.abcdef1",
      "0.13.0-local.20261001000000.abcdef1",
    ]) {
      useAssistantIdentityStore.getState().setIdentity("Test", version, "asst-1");
      expect(supportsGuardianNotificationTargeting("asst-1")).toBe(false);
    }
  });

  test("is false when the known version belongs to a different assistant", () => {
    useAssistantIdentityStore.getState().setIdentity("Test", "0.13.0", "asst-2");
    expect(supportsGuardianNotificationTargeting("asst-1")).toBe(false);
  });
});
