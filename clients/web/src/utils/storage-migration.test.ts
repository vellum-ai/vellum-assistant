import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { migrateKey, migratePrefix, migrateValue, removeKey, runStorageMigrations } from "./storage-migration";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("removeKey", () => {
  test("removes an existing key", () => {
    localStorage.setItem("old:key", "value");

    removeKey("old:key");

    expect(localStorage.getItem("old:key")).toBeNull();
  });

  test("no-op when key is absent", () => {
    removeKey("missing");

    expect(localStorage.getItem("missing")).toBeNull();
  });
});

describe("migrateValue", () => {
  test("converts matching old value to new value", () => {
    localStorage.setItem("key", "1");

    migrateValue("key", "1", "true");

    expect(localStorage.getItem("key")).toBe("true");
  });

  test("no-op when current value does not match old value", () => {
    localStorage.setItem("key", "true");

    migrateValue("key", "1", "true");

    expect(localStorage.getItem("key")).toBe("true");
  });

  test("no-op when key is absent", () => {
    migrateValue("missing", "1", "true");

    expect(localStorage.getItem("missing")).toBeNull();
  });
});

describe("migrateKey", () => {
  test("renames old key to new key", () => {
    localStorage.setItem("old:key", "value");

    migrateKey("old:key", "new:key");

    expect(localStorage.getItem("new:key")).toBe("value");
    expect(localStorage.getItem("old:key")).toBeNull();
  });

  test("no-op when old key is absent", () => {
    migrateKey("missing", "new:key");

    expect(localStorage.getItem("new:key")).toBeNull();
  });

  test("preserves existing new key (idempotent)", () => {
    localStorage.setItem("old:key", "stale");
    localStorage.setItem("new:key", "fresh");

    migrateKey("old:key", "new:key");

    expect(localStorage.getItem("new:key")).toBe("fresh");
    expect(localStorage.getItem("old:key")).toBeNull();
  });

  test("idempotent when called twice", () => {
    localStorage.setItem("old:key", "value");

    migrateKey("old:key", "new:key");
    migrateKey("old:key", "new:key");

    expect(localStorage.getItem("new:key")).toBe("value");
    expect(localStorage.getItem("old:key")).toBeNull();
  });
});

describe("migratePrefix", () => {
  test("renames all keys matching the old prefix", () => {
    // eslint-disable-next-line no-restricted-syntax -- test: verifying migration of storage keys
    localStorage.setItem("voice:ttsApiKey:openai", "sk-123");
    // eslint-disable-next-line no-restricted-syntax -- test: verifying migration of storage keys
    localStorage.setItem("voice:ttsApiKey:elevenlabs", "el-456");
    localStorage.setItem("voice:sttProvider", "whisper");

    migratePrefix("voice:ttsApiKey:", "vellum:voice:ttsApiKey:");

    expect(localStorage.getItem("vellum:voice:ttsApiKey:openai")).toBe("sk-123");
    expect(localStorage.getItem("vellum:voice:ttsApiKey:elevenlabs")).toBe("el-456");
    expect(localStorage.getItem("voice:ttsApiKey:openai")).toBeNull();
    expect(localStorage.getItem("voice:ttsApiKey:elevenlabs")).toBeNull();
    // Unrelated key untouched
    expect(localStorage.getItem("voice:sttProvider")).toBe("whisper");
  });

  test("no-op when no keys match", () => {
    localStorage.setItem("other:key", "value");

    migratePrefix("voice:", "vellum:voice:");

    expect(localStorage.getItem("other:key")).toBe("value");
    expect(localStorage.length).toBe(1);
  });

  test("preserves existing new keys (idempotent)", () => {
    localStorage.setItem("ff:client:flag-a", "old");
    localStorage.setItem("vellum:ff:flag-a", "already-migrated");

    migratePrefix("ff:client:", "vellum:ff:");

    expect(localStorage.getItem("vellum:ff:flag-a")).toBe("already-migrated");
    expect(localStorage.getItem("ff:client:flag-a")).toBeNull();
  });
});

describe("runStorageMigrations", () => {
  test("migrates sidebar keys", () => {
    localStorage.setItem("assistantSidebarCollapsed", "true");
    localStorage.setItem("assistantSidebarWidth", "300");

    runStorageMigrations();

    expect(localStorage.getItem("vellum:sidebar:collapsed")).toBe("true");
    expect(localStorage.getItem("vellum:sidebar:width")).toBe("300");
    expect(localStorage.getItem("assistantSidebarCollapsed")).toBeNull();
    expect(localStorage.getItem("assistantSidebarWidth")).toBeNull();
  });

  test("migrates voice: keys", () => {
    localStorage.setItem("voice:permissionPrimerSeen", "true");
    localStorage.setItem("voice:ttsProvider", "openai");
    localStorage.setItem("voice:sttProvider", "whisper");
    localStorage.setItem("voice:activationKey", "Space");
    // eslint-disable-next-line no-restricted-syntax -- test: verifying migration of API key storage keys
    localStorage.setItem("voice:ttsApiKey:openai", "sk-123");
    localStorage.setItem("voice:ttsVoiceId:openai", "alloy");
    // eslint-disable-next-line no-restricted-syntax -- test: verifying migration of API key storage keys
    localStorage.setItem("voice:sttApiKey:deepgram", "dg-456");

    runStorageMigrations();

    expect(localStorage.getItem("vellum:voice:permissionPrimerSeen")).toBe("true");
    expect(localStorage.getItem("vellum:voice:ttsProvider")).toBe("openai");
    expect(localStorage.getItem("vellum:voice:sttProvider")).toBe("whisper");
    expect(localStorage.getItem("vellum:voice:activationKey")).toBe("Space");
    expect(localStorage.getItem("vellum:voice:ttsApiKey:openai")).toBe("sk-123");
    expect(localStorage.getItem("vellum:voice:ttsVoiceId:openai")).toBe("alloy");
    expect(localStorage.getItem("vellum:voice:sttApiKey:deepgram")).toBe("dg-456");
    // Old keys removed
    expect(localStorage.getItem("voice:permissionPrimerSeen")).toBeNull();
    expect(localStorage.getItem("voice:ttsApiKey:openai")).toBeNull();
  });

  test("migrates onboarding. keys", () => {
    localStorage.setItem("onboarding.tosAccepted", "true");
    localStorage.setItem("onboarding.aiDataConsent", "true");
    localStorage.setItem("onboarding.completed", "true");
    localStorage.setItem("onboarding.selectedVersion", "v1.0");

    runStorageMigrations();

    expect(localStorage.getItem("vellum:onboarding:tosAccepted")).toBe("true");
    expect(localStorage.getItem("vellum:onboarding:aiDataConsent")).toBe("true");
    // completed key is removed (no longer used), not migrated
    expect(localStorage.getItem("onboarding.completed")).toBeNull();
    expect(localStorage.getItem("vellum:onboarding:completed")).toBeNull();
    expect(localStorage.getItem("vellum:onboarding:selectedVersion")).toBe("v1.0");
    expect(localStorage.getItem("onboarding.tosAccepted")).toBeNull();
  });

  test("migrates vellum_ AI settings keys", () => {
    localStorage.setItem("vellum_image_gen_mode", "enabled");
    localStorage.setItem("vellum_web_search_provider", "perplexity");
    localStorage.setItem("vellum_gemini_key", "gk-789");
    localStorage.setItem("vellum_perplexity_key", "pplx-abc");
    localStorage.setItem("vellum_brave_key", "BSA-def");
    localStorage.setItem("vellum_tavily_key", "tvly-ghi");

    runStorageMigrations();

    expect(localStorage.getItem("vellum:ai:imageGenMode")).toBe("enabled");
    expect(localStorage.getItem("vellum:ai:webSearchProvider")).toBe("perplexity");
    expect(localStorage.getItem("vellum:ai:geminiKey")).toBe("gk-789");
    expect(localStorage.getItem("vellum:ai:perplexityKey")).toBe("pplx-abc");
    expect(localStorage.getItem("vellum:ai:braveKey")).toBe("BSA-def");
    expect(localStorage.getItem("vellum:ai:tavilyKey")).toBe("tvly-ghi");
    expect(localStorage.getItem("vellum_image_gen_mode")).toBeNull();
  });

  test("migrates ff:client: prefix", () => {
    localStorage.setItem("ff:client:my-flag", "true");
    localStorage.setItem("ff:client:another-flag", "false");

    runStorageMigrations();

    expect(localStorage.getItem("vellum:ff:my-flag")).toBe("true");
    expect(localStorage.getItem("vellum:ff:another-flag")).toBe("false");
    expect(localStorage.getItem("ff:client:my-flag")).toBeNull();
  });

  test("migrates gw: and local: keys", () => {
    // eslint-disable-next-line no-restricted-syntax -- test: verifying migration of gateway token keys
    localStorage.setItem("gw:token", "jwt-abc");
    // generic-examples:ignore-next-line — reason: epoch timestamp, not a phone number
    localStorage.setItem("gw:expiresAt", "1700000000");
    // eslint-disable-next-line no-restricted-syntax -- test: verifying migration of gateway token keys
    localStorage.setItem("gw:tokenSource", "/auth/token");
    localStorage.setItem("local:lockfile", "{}");
    localStorage.setItem("local:selectedAssistantId", "asst-1");

    runStorageMigrations();

    expect(localStorage.getItem("vellum:gw:token")).toBe("jwt-abc");
    // generic-examples:ignore-next-line — reason: epoch timestamp, not a phone number
    expect(localStorage.getItem("vellum:gw:expiresAt")).toBe("1700000000");
    expect(localStorage.getItem("vellum:gw:tokenSource")).toBe("/auth/token");
    expect(localStorage.getItem("vellum:local:lockfile")).toBe("{}");
    // local:selectedAssistantId is canonicalized then collapsed into the single
    // vellum:selectedAssistantId, so the intermediate key no longer survives.
    expect(localStorage.getItem("vellum:selectedAssistantId")).toBe("asst-1");
    expect(localStorage.getItem("vellum:local:selectedAssistantId")).toBeNull();
    expect(localStorage.getItem("gw:token")).toBeNull();
    expect(localStorage.getItem("local:lockfile")).toBeNull();
  });

  test("migrates disk-pressure-warning prefix", () => {
    localStorage.setItem("disk-pressure-warning-dismissed-asst-1", "true");
    localStorage.setItem("disk-pressure-warning-dismissed-asst-2", "true");

    runStorageMigrations();

    expect(localStorage.getItem("vellum:diskPressureDismissed:asst-1")).toBe("true");
    expect(localStorage.getItem("vellum:diskPressureDismissed:asst-2")).toBe("true");
    expect(localStorage.getItem("disk-pressure-warning-dismissed-asst-1")).toBeNull();
  });

  test("collapses the legacy per-org assistant map into one key", () => {
    // Canonicalized first (vellum_current_assistant_id__ → vellum:currentAssistantId:),
    // then collapsed into the single vellum:selectedAssistantId. With no current
    // org at migration time, the lexicographically-smallest org suffix wins.
    localStorage.setItem("vellum_current_assistant_id__org-2", "asst-b");
    localStorage.setItem("vellum_current_assistant_id__org-1", "asst-a");

    runStorageMigrations();

    expect(localStorage.getItem("vellum:selectedAssistantId")).toBe("asst-a");
    expect(localStorage.getItem("vellum:currentAssistantId:org-1")).toBeNull();
    expect(localStorage.getItem("vellum:currentAssistantId:org-2")).toBeNull();
    expect(localStorage.getItem("vellum_current_assistant_id__org-1")).toBeNull();
  });

  test("collapse prefers the persisted active org's per-org selection", () => {
    // Active org is org-2 even though org-1 sorts first; the active org's pick
    // must win so a multi-org user keeps their current selection on upgrade.
    sessionStorage.setItem("vellum_active_organization_id", "org-2");
    localStorage.setItem("vellum:currentAssistantId:org-1", "asst-1");
    localStorage.setItem("vellum:currentAssistantId:org-2", "asst-2");

    runStorageMigrations();

    expect(localStorage.getItem("vellum:selectedAssistantId")).toBe("asst-2");
    expect(localStorage.getItem("vellum:currentAssistantId:org-1")).toBeNull();
    expect(localStorage.getItem("vellum:currentAssistantId:org-2")).toBeNull();
  });

  test("collapse prefers the tab-local key and is idempotent", () => {
    localStorage.setItem("vellum:local:selectedAssistantId", "tab-local");
    localStorage.setItem("vellum:currentAssistantId:org-1", "per-org");

    runStorageMigrations();
    expect(localStorage.getItem("vellum:selectedAssistantId")).toBe("tab-local");
    expect(localStorage.getItem("vellum:local:selectedAssistantId")).toBeNull();
    expect(localStorage.getItem("vellum:currentAssistantId:org-1")).toBeNull();

    // Re-running leaves the collapsed value untouched and removes nothing new.
    runStorageMigrations();
    expect(localStorage.getItem("vellum:selectedAssistantId")).toBe("tab-local");
  });

  test("migrates vellumDebug key", () => {
    localStorage.setItem("vellumDebug.flags.impersonateAssistantVersion", "0.8.6");

    runStorageMigrations();

    expect(localStorage.getItem("vellum:debug:impersonateAssistantVersion")).toBe("0.8.6");
    expect(localStorage.getItem("vellumDebug.flags.impersonateAssistantVersion")).toBeNull();
  });

  test("migrates skillsTabTipDismissed to new name", () => {
    localStorage.setItem("vellum:skillsTabTipDismissed", "true");

    runStorageMigrations();

    expect(localStorage.getItem("vellum:skills:tipDismissed")).toBe("true");
    expect(localStorage.getItem("vellum:skillsTabTipDismissed")).toBeNull();
  });

  test("converts skills tip value from '1' to 'true'", () => {
    localStorage.setItem("vellum:skills:tipDismissed", "1");

    runStorageMigrations();

    expect(localStorage.getItem("vellum:skills:tipDismissed")).toBe("true");
  });

  test("does not touch device: keys", () => {
    localStorage.setItem("device:theme", "dark");
    localStorage.setItem("device:timezone", "UTC");

    runStorageMigrations();

    expect(localStorage.getItem("device:theme")).toBe("dark");
    expect(localStorage.getItem("device:timezone")).toBe("UTC");
  });

  test("does not touch third-party keys", () => {
    localStorage.setItem("_ga", "GA1.2.123456");
    localStorage.setItem("intercom-session", "abc");

    runStorageMigrations();

    expect(localStorage.getItem("_ga")).toBe("GA1.2.123456");
    expect(localStorage.getItem("intercom-session")).toBe("abc");
  });

  test("removes legacy nudge keys and their cleanup flag", () => {
    localStorage.setItem("app.githubNudge.starred", "true");
    localStorage.setItem("app.discordNudge.joined", "true");
    localStorage.setItem("app.nudgeLegacy.cleaned", "true");

    runStorageMigrations();

    expect(localStorage.getItem("app.githubNudge.starred")).toBeNull();
    expect(localStorage.getItem("app.discordNudge.joined")).toBeNull();
    expect(localStorage.getItem("app.nudgeLegacy.cleaned")).toBeNull();
  });

  test("full migration is idempotent", () => {
    localStorage.setItem("assistantSidebarCollapsed", "true");
    localStorage.setItem("voice:ttsProvider", "openai");
    localStorage.setItem("onboarding.tosAccepted", "true");
    localStorage.setItem("ff:client:flag", "true");

    runStorageMigrations();
    const snapshot1 = { ...localStorage };

    runStorageMigrations();
    const snapshot2 = { ...localStorage };

    expect(snapshot1).toEqual(snapshot2);
  });
});
