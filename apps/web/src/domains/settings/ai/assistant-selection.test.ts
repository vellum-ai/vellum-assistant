import { describe, expect, test } from "bun:test";

import {
  aiSettingsAssistantListHosting,
  isSelfHostedAiSettingsAssistant,
  resolveAiSettingsAssistantId,
} from "@/domains/settings/ai/assistant-selection";

describe("AI settings assistant selection", () => {
  test("uses the lifecycle assistant id for self-hosted assistants", () => {
    expect(
      resolveAiSettingsAssistantId({
        isSelfHosted: true,
        lifecycleAssistantId: "self-hosted-assistant",
        assistantList: { results: [] },
      }),
    ).toBe("self-hosted-assistant");
  });

  test("falls back to the fetched list when no lifecycle id is available", () => {
    expect(
      resolveAiSettingsAssistantId({
        isSelfHosted: true,
        lifecycleAssistantId: null,
        assistantList: { results: [{ id: "local-assistant" }] },
      }),
    ).toBe("local-assistant");
  });

  test("uses the fetched platform assistant for platform-hosted settings", () => {
    expect(
      resolveAiSettingsAssistantId({
        isSelfHosted: false,
        lifecycleAssistantId: "active-runtime-assistant",
        assistantList: { results: [{ id: "platform-assistant" }] },
      }),
    ).toBe("platform-assistant");
  });

  test("requests the assistant list for the active hosting mode", () => {
    expect(aiSettingsAssistantListHosting(true)).toBe("local");
    expect(aiSettingsAssistantListHosting(false)).toBe("platform");
  });

  test("treats both self-hosted and local-active lifecycle states as local", () => {
    expect(isSelfHostedAiSettingsAssistant({ kind: "self_hosted" })).toBeTrue();
    expect(
      isSelfHostedAiSettingsAssistant({ kind: "active", isLocal: true }),
    ).toBeTrue();
    expect(
      isSelfHostedAiSettingsAssistant({ kind: "active", isLocal: false }),
    ).toBeFalse();
  });
});
