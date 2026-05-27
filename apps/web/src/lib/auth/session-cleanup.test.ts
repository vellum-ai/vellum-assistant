import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearUserScopedStorage } from "./session-cleanup";

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

  test("removes all user-scoped app keys from localStorage", () => {
    localStorage.setItem("vellum:pinnedApps", "[]");
    localStorage.setItem("vellum:lastViewedConversation:asst-1", "conv-1");
    localStorage.setItem("vellum:sidebar-open-categories:asst-1", "{}");
    localStorage.setItem("vellum:sidebar-open-custom-groups:asst-1", "{}");
    localStorage.setItem("vellum_current_assistant_id__org-1", "asst-1");
    localStorage.setItem("vellum:nudge-prefs", "{}");
    localStorage.setItem("vellum:chatDrafts:asst-1", '{"text":"hi"}');
    localStorage.setItem("vellum:ctxwindow:asst-1", "4096");
    localStorage.setItem("vellum:dismissed-surfaces:asst-1", "[]");
    localStorage.setItem("ff:client:some-flag", "true");
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

  test("preserves device: prefixed keys", () => {
    localStorage.setItem("device:theme", "dark");
    localStorage.setItem("device:share_analytics", "true");
    localStorage.setItem("device:share_diagnostics", "false");
    localStorage.setItem("device:biometric_enabled", "false");
    localStorage.setItem("device:llm_log_retention", "dontRetain");
    localStorage.setItem("device:timezone", "America/New_York");
    localStorage.setItem("device:media_embeds_enabled", "false");
    localStorage.setItem("device:media_embed_domains", '["youtube.com"]');
    localStorage.setItem("device:last_user_id", "user-123");

    clearUserScopedStorage();

    expect(localStorage.getItem("device:theme")).toBe("dark");
    expect(localStorage.getItem("device:share_analytics")).toBe("true");
    expect(localStorage.getItem("device:share_diagnostics")).toBe("false");
    expect(localStorage.getItem("device:biometric_enabled")).toBe("false");
    expect(localStorage.getItem("device:llm_log_retention")).toBe("dontRetain");
    expect(localStorage.getItem("device:timezone")).toBe("America/New_York");
    expect(localStorage.getItem("device:media_embeds_enabled")).toBe("false");
    expect(localStorage.getItem("device:media_embed_domains")).toBe('["youtube.com"]');
    expect(localStorage.getItem("device:last_user_id")).toBe("user-123");
  });

  test("preserves legacy device-level keys (transitional safety net)", () => {
    localStorage.setItem("vellum_theme", "dark");
    localStorage.setItem("vellum_share_analytics", "true");
    localStorage.setItem("vellum_share_diagnostics", "false");
    localStorage.setItem("vellum_biometric_enabled", "true");
    localStorage.setItem("vellum_llm_log_retention", "dontRetain");
    localStorage.setItem("vellum_timezone", "America/New_York");
    localStorage.setItem("vellum_media_embeds_enabled", "false");
    localStorage.setItem("vellum_media_embed_domains", '["youtube.com"]');
    localStorage.setItem("onboarding.lastUserId", "user-123");

    clearUserScopedStorage();

    expect(localStorage.getItem("vellum_theme")).toBe("dark");
    expect(localStorage.getItem("vellum_share_analytics")).toBe("true");
    expect(localStorage.getItem("vellum_share_diagnostics")).toBe("false");
    expect(localStorage.getItem("vellum_biometric_enabled")).toBe("true");
    expect(localStorage.getItem("vellum_llm_log_retention")).toBe("dontRetain");
    expect(localStorage.getItem("vellum_timezone")).toBe("America/New_York");
    expect(localStorage.getItem("vellum_media_embeds_enabled")).toBe("false");
    expect(localStorage.getItem("vellum_media_embed_domains")).toBe('["youtube.com"]');
    expect(localStorage.getItem("onboarding.lastUserId")).toBe("user-123");
  });

  test("automatically clears future app keys without needing explicit registration", () => {
    localStorage.setItem("vellum:some-future-feature:asst-1", "data");
    localStorage.setItem("vellum_new_preference", "value");
    localStorage.setItem("onboarding.newFlag", "true");
    localStorage.setItem("ff:client:new-experiment", "variant-b");
    localStorage.setItem("voice:newSetting", "on");
    localStorage.setItem("integrations.newBanner", "dismissed");

    clearUserScopedStorage();

    expect(localStorage.length).toBe(0);
  });

  test("future device: keys are automatically preserved", () => {
    localStorage.setItem("device:some_new_setting", "value");
    localStorage.setItem("device:another_setting", "data");

    clearUserScopedStorage();

    expect(localStorage.getItem("device:some_new_setting")).toBe("value");
    expect(localStorage.getItem("device:another_setting")).toBe("data");
  });

  test("leaves third-party keys untouched", () => {
    localStorage.setItem("_ga", "GA1.2.123456");
    localStorage.setItem("intercom-session", "abc");
    localStorage.setItem("some-other-sdk", "data");

    clearUserScopedStorage();

    expect(localStorage.getItem("_ga")).toBe("GA1.2.123456");
    expect(localStorage.getItem("intercom-session")).toBe("abc");
    expect(localStorage.getItem("some-other-sdk")).toBe("data");
  });

  test("removes user-scoped keys while preserving device and third-party keys", () => {
    localStorage.setItem("device:theme", "dark");
    localStorage.setItem("device:share_analytics", "true");
    localStorage.setItem("vellum:pinnedApps", "[]");
    localStorage.setItem("ff:client:my-flag", "true");
    localStorage.setItem("onboarding.completed", "true");
    localStorage.setItem("_ga", "GA1.2.123456");

    clearUserScopedStorage();

    expect(localStorage.getItem("device:theme")).toBe("dark");
    expect(localStorage.getItem("device:share_analytics")).toBe("true");
    expect(localStorage.getItem("_ga")).toBe("GA1.2.123456");
    expect(localStorage.getItem("vellum:pinnedApps")).toBeNull();
    expect(localStorage.getItem("ff:client:my-flag")).toBeNull();
    expect(localStorage.getItem("onboarding.completed")).toBeNull();
  });
});
