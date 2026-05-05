import type { OnboardingContext } from "../types/onboarding-context.js";

/**
 * Map of known tool IDs (from the client onboarding UI) to display labels.
 * Unknown IDs pass through with first-letter capitalization via `normalizeTools`.
 */
export const TOOL_DISPLAY_NAMES: Record<string, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  "google-calendar": "Google Calendar",
  slack: "Slack",
  notion: "Notion",
  linear: "Linear",
  jira: "Jira",
  github: "GitHub",
  figma: "Figma",
  "google-drive": "Google Drive",
  excel: "Excel",
  "apple-notes": "Apple Notes",
};

/**
 * Map of known task IDs to plain-language labels describing what the assistant
 * does for each task category.
 */
export const TASK_DISPLAY_LABELS: Record<string, string> = {
  "code-building": "builds code, apps, or tools",
  writing: "writes docs, emails, or content",
  research: "does research and analysis",
  "project-management": "plans and coordinates work",
  scheduling: "handles meetings, calendar, and logistics",
  personal: "handles life admin",
};

/**
 * Capitalize the first letter of a string (fallback for unknown IDs).
 */
function capitalizeFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Maps each tool ID through `TOOL_DISPLAY_NAMES`, falling back to the raw
 * string for unknown IDs.
 */
export function normalizeTools(tools: string[]): string[] {
  return tools.map((id) => TOOL_DISPLAY_NAMES[id] ?? capitalizeFirst(id));
}

/**
 * Maps each task ID through `TASK_DISPLAY_LABELS`, falling back to the raw
 * string for unknown IDs.
 */
export function normalizeTasks(tasks: string[]): string[] {
  return tasks.map((id) => TASK_DISPLAY_LABELS[id] ?? id);
}

export interface NormalizedOnboarding {
  preferredName?: string;
  commonWork: string[];
  dailyTools: string[];
  tone?: string;
  assistantName?: string;
}

/**
 * Normalizes raw onboarding context from the client into display-ready data.
 */
export function normalizeOnboardingContext(
  ctx: OnboardingContext,
): NormalizedOnboarding {
  return {
    preferredName: ctx.userName?.trim() || undefined,
    commonWork: normalizeTasks(ctx.tasks),
    dailyTools: normalizeTools(ctx.tools),
    tone: ctx.tone,
    assistantName: ctx.assistantName,
  };
}
