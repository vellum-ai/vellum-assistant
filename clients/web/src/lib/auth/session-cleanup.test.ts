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
    sessionStorage.setItem("vellum:edit-chat:asst-1:app-1", "conv-xyz");
    sessionStorage.setItem("arbitrary-session-key", "data");

    clearUserScopedStorage();

    expect(sessionStorage.length).toBe(0);
  });

  test("removes all vellum: prefixed keys from localStorage", () => {
    localStorage.setItem("vellum:pinnedApps", "[]");
    localStorage.setItem("vellum:lastViewedConversation:asst-1", "conv-1");
    localStorage.setItem("vellum:sidebar-open-categories:asst-1", "{}");
    localStorage.setItem("vellum:sidebar-open-custom-groups:asst-1", "{}");
    localStorage.setItem("vellum:selectedAssistantId", "asst-1");
    localStorage.setItem("vellum:nudge-prefs", "{}");
    localStorage.setItem("vellum:chatDrafts:asst-1", '{"text":"hi"}');
    localStorage.setItem("vellum:ctxwindow:asst-1", "4096");
    localStorage.setItem("vellum:dismissed-surfaces:asst-1", "[]");
    localStorage.setItem("vellum:ff:some-flag", "true");
    localStorage.setItem("vellum:onboarding:tosAccepted", "true");
    localStorage.setItem("vellum:onboarding:aiDataConsent", "true");
    localStorage.setItem("vellum:onboarding:completed", "true");
    localStorage.setItem("vellum:onboarding:selectedVersion", "v1.0");
    localStorage.setItem("vellum:integrations:bannerDismissed", "true");
    localStorage.setItem("vellum:voice:activationKey", "Space");
    // eslint-disable-next-line no-restricted-syntax -- test: verifying cleanup of user-scoped storage keys
    localStorage.setItem("vellum:voice:ttsApiKey:openai", "test-value");
    // eslint-disable-next-line no-restricted-syntax -- test: verifying cleanup of user-scoped storage keys
    localStorage.setItem("vellum:voice:sttApiKey:openai", "test-value");
    // eslint-disable-next-line no-restricted-syntax -- test: verifying cleanup of user-scoped storage keys
    localStorage.setItem("vellum:gw:token", "jwt-token");
    localStorage.setItem("vellum:local:lockfile", "{}");
    localStorage.setItem("vellum:ai:imageGenMode", "enabled");
    localStorage.setItem("vellum:debug:impersonateAssistantVersion", "0.8.6");
    localStorage.setItem("vellum:sidebar:collapsed", "true");
    localStorage.setItem("vellum:sidebar:width", "300");
    localStorage.setItem("vellum:diskPressureDismissed:asst-1", "true");
    localStorage.setItem("vellum:skills:tipDismissed", "true");

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

  test("automatically clears future vellum: keys without needing explicit registration", () => {
    localStorage.setItem("vellum:some-future-feature:asst-1", "data");
    localStorage.setItem("vellum:another-feature", "value");

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

  test("removes vellum: keys while preserving device: and third-party keys", () => {
    localStorage.setItem("device:theme", "dark");
    localStorage.setItem("device:share_analytics", "true");
    localStorage.setItem("vellum:pinnedApps", "[]");
    localStorage.setItem("vellum:ff:my-flag", "true");
    localStorage.setItem("vellum:onboarding:completed", "true");
    localStorage.setItem("_ga", "GA1.2.123456");

    clearUserScopedStorage();

    expect(localStorage.getItem("device:theme")).toBe("dark");
    expect(localStorage.getItem("device:share_analytics")).toBe("true");
    expect(localStorage.getItem("_ga")).toBe("GA1.2.123456");
    expect(localStorage.getItem("vellum:pinnedApps")).toBeNull();
    expect(localStorage.getItem("vellum:ff:my-flag")).toBeNull();
    expect(localStorage.getItem("vellum:onboarding:completed")).toBeNull();
  });

  test("preserves active app. nudge keys on logout", () => {
    localStorage.setItem("app.iosNudge.downloaded", "true");
    localStorage.setItem("app.macOsNudge.bannerDismissed", "true");
    localStorage.setItem("app.githubNudge.starred", "true");

    clearUserScopedStorage();

    // Active iOS/macOS nudge keys must survive logout — they are
    // still read by use-ios-app-nudge.ts and use-macos-app-nudge.ts.
    // Dead github/discord keys are removed at startup by removeKey()
    // in storage-migration.ts, not by the logout sweep.
    expect(localStorage.getItem("app.iosNudge.downloaded")).toBe("true");
    expect(localStorage.getItem("app.macOsNudge.bannerDismissed")).toBe("true");
    expect(localStorage.getItem("app.githubNudge.starred")).toBe("true");
  });

  test("clears legacy prefixed keys if startup migration failed", () => {
    // eslint-disable-next-line no-restricted-syntax -- test: verifying cleanup of legacy auth token
    localStorage.setItem("gw:token", "legacy-jwt-token");
    // generic-examples:ignore-next-line — reason: epoch timestamp for token expiry, not a phone number
    localStorage.setItem("gw:expiresAt", "9999999999");
    localStorage.setItem("voice:ttsProvider", "elevenlabs");
    localStorage.setItem("onboarding.completed", "true");
    localStorage.setItem("ff:client:darkMode", "true");
    localStorage.setItem("local:lockfile", "{}");
    localStorage.setItem("integrations.bannerDismissed", "true");
    localStorage.setItem("vellumDebug.flags.impersonateAssistantVersion", "0.8.6");
    localStorage.setItem("vellum_image_gen_mode", "enabled");

    clearUserScopedStorage();

    expect(localStorage.getItem("gw:token")).toBeNull();
    expect(localStorage.getItem("gw:expiresAt")).toBeNull();
    expect(localStorage.getItem("voice:ttsProvider")).toBeNull();
    expect(localStorage.getItem("onboarding.completed")).toBeNull();
    expect(localStorage.getItem("ff:client:darkMode")).toBeNull();
    expect(localStorage.getItem("local:lockfile")).toBeNull();
    expect(localStorage.getItem("integrations.bannerDismissed")).toBeNull();
    expect(localStorage.getItem("vellumDebug.flags.impersonateAssistantVersion")).toBeNull();
    expect(localStorage.getItem("vellum_image_gen_mode")).toBeNull();
  });

  test("preserves legacy device-level keys from cleanup", () => {
    localStorage.setItem("vellum_theme", "dark");
    localStorage.setItem("vellum_share_analytics", "true");
    localStorage.setItem("vellum_share_diagnostics", "false");
    localStorage.setItem("vellum_biometric_enabled", "false");
    localStorage.setItem("vellum_llm_log_retention", "dontRetain");
    localStorage.setItem("vellum_timezone", "America/New_York");
    localStorage.setItem("vellum_media_embeds_enabled", "false");
    localStorage.setItem("vellum_media_embed_domains", '["youtube.com"]');
    localStorage.setItem("onboarding.lastUserId", "user-123");

    clearUserScopedStorage();

    expect(localStorage.getItem("vellum_theme")).toBe("dark");
    expect(localStorage.getItem("vellum_share_analytics")).toBe("true");
    expect(localStorage.getItem("vellum_share_diagnostics")).toBe("false");
    expect(localStorage.getItem("vellum_biometric_enabled")).toBe("false");
    expect(localStorage.getItem("vellum_llm_log_retention")).toBe("dontRetain");
    expect(localStorage.getItem("vellum_timezone")).toBe("America/New_York");
    expect(localStorage.getItem("vellum_media_embeds_enabled")).toBe("false");
    expect(localStorage.getItem("vellum_media_embed_domains")).toBe('["youtube.com"]');
    expect(localStorage.getItem("onboarding.lastUserId")).toBe("user-123");
  });
});
