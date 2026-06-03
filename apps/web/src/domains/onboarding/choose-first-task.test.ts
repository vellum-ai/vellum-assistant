import { describe, expect, test } from "bun:test";

import {
  chooseFirstTask,
  INBOX_CLEANUP_TASK_ID,
} from "@/domains/onboarding/choose-first-task";
import type { PreChatOnboardingContext } from "@/domains/onboarding/prechat";

function baseContext(
  overrides: Partial<PreChatOnboardingContext> = {},
): PreChatOnboardingContext {
  return {
    tools: [],
    tasks: [],
    tone: "balanced",
    ...overrides,
  };
}

describe("chooseFirstTask", () => {
  test("returns the inbox-cleanup constant for an empty context", () => {
    expect(chooseFirstTask(baseContext())).toBe(INBOX_CLEANUP_TASK_ID);
    expect(INBOX_CLEANUP_TASK_ID).toBe("inbox-cleanup");
  });

  test("returns the inbox-cleanup constant for a populated context", () => {
    const context = baseContext({
      tools: ["slack", "linear"],
      tasks: ["code-building", "writing"],
      cohort: "content-automation",
      googleConnected: true,
    });
    expect(chooseFirstTask(context)).toBe("inbox-cleanup");
  });
});
