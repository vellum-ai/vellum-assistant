/**
 * Tests for the assistant version-impersonation dev flag.
 *
 * Covers:
 *   - localStorage round-trip via get/set
 *   - inspect-only mode (`undefined` arg) is non-destructive and
 *     does not reload
 *   - explicit `null`/empty-string clears
 *   - assistant identity store funnels impersonated value through
 *     `setIdentity` regardless of the value the caller passed
 *   - real version comes back after the override is cleared
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  getImpersonatedAssistantVersion,
  setImpersonatedAssistantVersion,
} from "@/lib/backwards-compat/impersonate-version-flag";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const STORAGE_KEY = "vellum:debug:impersonateAssistantVersion";

describe("impersonate-version-flag", () => {
  let originalReload: typeof window.location.reload;
  let reloadCalls: number;

  beforeEach(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    useAssistantIdentityStore.getState().clearIdentity();
    reloadCalls = 0;
    // location.reload is non-configurable in jsdom — replace at the
    // descriptor level so we can count calls without actually
    // reloading the test process.
    originalReload = window.location.reload;
    Object.defineProperty(window.location, "reload", {
      configurable: true,
      value: mock(() => {
        reloadCalls += 1;
      }),
    });
  });

  afterEach(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    useAssistantIdentityStore.getState().clearIdentity();
    Object.defineProperty(window.location, "reload", {
      configurable: true,
      value: originalReload,
    });
  });

  test("get returns null when no override is set", () => {
    expect(getImpersonatedAssistantVersion()).toBeNull();
  });

  test("set persists a version string and triggers reload", () => {
    const result = setImpersonatedAssistantVersion("0.8.6");
    expect(result).toBe("0.8.6");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("0.8.6");
    expect(reloadCalls).toBe(1);
    expect(getImpersonatedAssistantVersion()).toBe("0.8.6");
  });

  test("explicit null clears and reloads", () => {
    window.localStorage.setItem(STORAGE_KEY, "0.9.0");
    const result = setImpersonatedAssistantVersion(null);
    expect(result).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(reloadCalls).toBe(1);
    expect(getImpersonatedAssistantVersion()).toBeNull();
  });

  test("empty string clears (same as null)", () => {
    window.localStorage.setItem(STORAGE_KEY, "0.9.0");
    const result = setImpersonatedAssistantVersion("");
    expect(result).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("undefined arg is inspect-only — no reload, no mutation", () => {
    window.localStorage.setItem(STORAGE_KEY, "0.8.6");
    const result = setImpersonatedAssistantVersion();
    expect(result).toBe("0.8.6");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("0.8.6");
    expect(reloadCalls).toBe(0);
  });

  test("undefined arg returns null when nothing is set", () => {
    const result = setImpersonatedAssistantVersion();
    expect(result).toBeNull();
    expect(reloadCalls).toBe(0);
  });

  test("identity store substitutes impersonated version on setIdentity", () => {
    // Stash an impersonation directly (bypassing reload) and verify
    // that every setIdentity call funnels through the override —
    // the caller's `version` arg is ignored when the flag is set.
    window.localStorage.setItem(STORAGE_KEY, "0.8.6");

    useAssistantIdentityStore.getState().setIdentity("Vel", "0.7.0");
    expect(useAssistantIdentityStore.getState().version).toBe("0.8.6");

    useAssistantIdentityStore.getState().setIdentity("Vel", null);
    expect(useAssistantIdentityStore.getState().version).toBe("0.8.6");

    useAssistantIdentityStore.getState().setIdentity("Vel", "0.9.99");
    expect(useAssistantIdentityStore.getState().version).toBe("0.8.6");
  });

  test("identity store passes through real version when no override is set", () => {
    useAssistantIdentityStore.getState().setIdentity("Vel", "0.7.0");
    expect(useAssistantIdentityStore.getState().version).toBe("0.7.0");

    useAssistantIdentityStore.getState().setIdentity("Vel", null);
    expect(useAssistantIdentityStore.getState().version).toBeNull();
  });

  test("clearing the override restores real-version passthrough on next setIdentity", () => {
    window.localStorage.setItem(STORAGE_KEY, "0.8.6");
    useAssistantIdentityStore.getState().setIdentity("Vel", "0.7.0");
    expect(useAssistantIdentityStore.getState().version).toBe("0.8.6");

    window.localStorage.removeItem(STORAGE_KEY);
    useAssistantIdentityStore.getState().setIdentity("Vel", "0.7.0");
    expect(useAssistantIdentityStore.getState().version).toBe("0.7.0");
  });
});
