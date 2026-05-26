import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearUserScopedStorage } from "./session-cleanup.js";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("clearUserScopedStorage", () => {
  test("clears sessionStorage entirely", () => {
    sessionStorage.setItem("vellum_active_organization_id", "org-123");
    sessionStorage.setItem("vellum:edit-chat:asst-1:app-1", "conv-xyz");

    clearUserScopedStorage();

    expect(sessionStorage.length).toBe(0);
  });

  test("removes user-scoped localStorage keys", () => {
    localStorage.setItem("vellum:pinnedApps", "[]");
    localStorage.setItem("vellum:lastViewedConversation:asst-1", "conv-1");
    localStorage.setItem("vellum:sidebar-open-categories:asst-1", "{}");
    localStorage.setItem("vellum:sidebar-open-custom-groups:asst-1", "{}");
    localStorage.setItem("vellum_current_assistant_id__org-1", "asst-1");
    localStorage.setItem("vellum:nudge-prefs", "{}");
    localStorage.setItem("ff:client:some-flag", "true");
    localStorage.setItem("vellum_biometric_enabled", "true");
    localStorage.setItem("onboarding.tosAccepted", "true");
    localStorage.setItem("onboarding.aiDataConsent", "true");
    localStorage.setItem("onboarding.completed", "true");
    localStorage.setItem("onboarding.selectedVersion", "v1.0");
    localStorage.setItem("integrations.bannerDismissed", "true");
    localStorage.setItem("voice:activationKey", "Space");
    // eslint-disable-next-line no-restricted-syntax -- test: verifying cleanup of user-scoped storage keys
    localStorage.setItem("voice:ttsApiKey:openai", "test-value");
    // eslint-disable-next-line no-restricted-syntax -- test: verifying cleanup of user-scoped storage keys
    localStorage.setItem("voice:sttApiKey:openai", "test-value");

    clearUserScopedStorage();

    expect(localStorage.length).toBe(0);
  });

  test("preserves device-level preferences", () => {
    localStorage.setItem("vellum_theme", "dark");
    localStorage.setItem("vellum_share_analytics", "true");
    localStorage.setItem("vellum_share_diagnostics", "false");
    localStorage.setItem("onboarding.lastUserId", "user-123");

    clearUserScopedStorage();

    expect(localStorage.getItem("vellum_theme")).toBe("dark");
    expect(localStorage.getItem("vellum_share_analytics")).toBe("true");
    expect(localStorage.getItem("vellum_share_diagnostics")).toBe("false");
    expect(localStorage.getItem("onboarding.lastUserId")).toBe("user-123");
  });

  test("removes user-scoped keys while preserving device-level keys", () => {
    localStorage.setItem("vellum_theme", "dark");
    localStorage.setItem("vellum:pinnedApps", "[]");
    localStorage.setItem("vellum_share_analytics", "true");
    localStorage.setItem("ff:client:my-flag", "true");
    localStorage.setItem("onboarding.lastUserId", "user-123");
    localStorage.setItem("onboarding.completed", "true");

    clearUserScopedStorage();

    expect(localStorage.getItem("vellum_theme")).toBe("dark");
    expect(localStorage.getItem("vellum_share_analytics")).toBe("true");
    expect(localStorage.getItem("onboarding.lastUserId")).toBe("user-123");
    expect(localStorage.getItem("vellum:pinnedApps")).toBeNull();
    expect(localStorage.getItem("ff:client:my-flag")).toBeNull();
    expect(localStorage.getItem("onboarding.completed")).toBeNull();
  });
});
