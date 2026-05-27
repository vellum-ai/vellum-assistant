import {
  setPendingPreChatContext,
  type PreChatOnboardingContext,
} from "@/domains/onboarding/prechat";
import { DEFAULT_GROUP_ID } from "@/domains/onboarding/prechat-names";

export const CONTENT_AUTOMATION_INITIAL_MESSAGE =
  "I want to write articles that rank better for GEO.";

export function buildContentAutomationPreChatContext(): PreChatOnboardingContext {
  return {
    tools: [],
    tasks: ["writing", "research", "project-management"],
    tone: DEFAULT_GROUP_ID,
    googleConnected: false,
    cohort: "content-automation",
    initialMessage: CONTENT_AUTOMATION_INITIAL_MESSAGE,
  };
}

export function persistContentAutomationPreChatHandoff(): void {
  setPendingPreChatContext(buildContentAutomationPreChatContext());
}
