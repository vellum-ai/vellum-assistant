import { beforeEach, describe, expect, test } from "bun:test";

import {
  ONBOARDED_ASSISTANTS_STORAGE_KEY,
  forgetAssistantOnboarded,
  markAssistantOnboarded,
  readOnboardedAt,
} from "@/domains/onboarding/onboarded-assistant-record";

describe("onboarded-assistant-record", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("stamps and reads back per assistant", () => {
    markAssistantOnboarded("asst-1", "2026-08-31T00:00:00.000Z");

    expect(readOnboardedAt("asst-1")).toBe("2026-08-31T00:00:00.000Z");
    expect(readOnboardedAt("asst-2")).toBeUndefined();
  });

  test("keeps the first stamp so a replayed funnel does not rewrite it", () => {
    markAssistantOnboarded("asst-1", "2026-08-01T00:00:00.000Z");
    markAssistantOnboarded("asst-1", "2026-08-31T00:00:00.000Z");

    expect(readOnboardedAt("asst-1")).toBe("2026-08-01T00:00:00.000Z");
  });

  test("forget drops one entry and leaves the others", () => {
    markAssistantOnboarded("asst-1", "2026-08-01T00:00:00.000Z");
    markAssistantOnboarded("asst-2", "2026-08-02T00:00:00.000Z");

    forgetAssistantOnboarded("asst-1");

    expect(readOnboardedAt("asst-1")).toBeUndefined();
    expect(readOnboardedAt("asst-2")).toBe("2026-08-02T00:00:00.000Z");
  });

  test("malformed storage reads as empty rather than throwing", () => {
    localStorage.setItem(ONBOARDED_ASSISTANTS_STORAGE_KEY, "not-json");
    expect(readOnboardedAt("asst-1")).toBeUndefined();

    localStorage.setItem(ONBOARDED_ASSISTANTS_STORAGE_KEY, '["asst-1"]');
    expect(readOnboardedAt("asst-1")).toBeUndefined();

    localStorage.setItem(ONBOARDED_ASSISTANTS_STORAGE_KEY, '{"asst-1":7}');
    expect(readOnboardedAt("asst-1")).toBeUndefined();
  });

  // Onboarding completion belongs to the assistant, not the session, so the
  // key is `device:`-scoped and survives the logout sweep in session-cleanup.
  test("is device-scoped", () => {
    expect(ONBOARDED_ASSISTANTS_STORAGE_KEY.startsWith("device:")).toBe(true);
  });
});
