import {
  setPendingInitialMessage,
  setPendingPreChatContext,
  type PreChatOnboardingContext,
} from "@/domains/onboarding/prechat.js";
import { DEFAULT_GROUP_ID } from "@/domains/onboarding/prechat-names.js";

export const CONTENT_AUTOMATION_INITIAL_MESSAGE =
  "I want to write articles that rank better for GEO.";

export function buildContentAutomationPreChatContext(): PreChatOnboardingContext {
  return {
    tools: [],
    tasks: ["writing", "research", "project-management"],
    tone: DEFAULT_GROUP_ID,
    googleConnected: false,
    cohort: "content-automation",
  };
}

export function persistContentAutomationPreChatHandoff(): void {
  const context = buildContentAutomationPreChatContext();
  setPendingPreChatContext(context);
  setPendingInitialMessage(CONTENT_AUTOMATION_INITIAL_MESSAGE);
}
