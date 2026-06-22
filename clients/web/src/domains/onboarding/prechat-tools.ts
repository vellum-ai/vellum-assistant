/**
 * Tool catalog for the PreChat onboarding tool-selection screen.
 *
 * Mirrors the macOS `ToolItem.allTools` list from
 * `vellum-assistant/clients/.../PreChatOnboardingFlow.swift`. The order here
 * is significant — the screen renders tools in this order.
 *
 * `logoSrc` is the public path under `/images/integrations/`, or `null` for
 * tools that don't have a brand asset (the screen falls back to initials).
 *
 * `logoSrcDark` is an optional alternate asset shown in dark mode. Only set
 * it when the default `logoSrc` doesn't have enough contrast on the dark
 * card surface (e.g. monochrome marks like the GitHub Octocat that are
 * dark-on-light by default).
 */

import { publicAsset } from "@/utils/public-asset";

export interface PreChatToolItem {
  id: string;
  label: string;
  logoSrc: string | null;
  logoSrcDark?: string;
}

export const GOOGLE_TOOL_IDS = new Set(["gmail", "google-calendar", "google-drive"]);

export const PRECHAT_TOOLS: PreChatToolItem[] = [
  { id: "gmail", label: "Gmail", logoSrc: publicAsset("/images/integrations/gmail.svg") },
  {
    id: "outlook",
    label: "Outlook",
    logoSrc: publicAsset("/images/integrations/outlook.png"),
  },
  {
    id: "google-calendar",
    label: "Google Calendar",
    logoSrc: publicAsset("/images/integrations/google-calendar.svg"),
  },
  { id: "slack", label: "Slack", logoSrc: publicAsset("/images/integrations/slack.svg") },
  { id: "notion", label: "Notion", logoSrc: publicAsset("/images/integrations/notion.svg") },
  {
    id: "linear",
    label: "Linear",
    logoSrc: publicAsset("/images/integrations/linear-light-logo.svg"),
  },
  {
    id: "jira",
    label: "Jira",
    logoSrc: publicAsset("/images/integrations/jira.svg"),
  },
  {
    id: "github",
    label: "GitHub",
    logoSrc: publicAsset("/images/integrations/github.svg"),
    logoSrcDark: publicAsset("/images/integrations/github-dark.svg"),
  },
  { id: "figma", label: "Figma", logoSrc: publicAsset("/images/integrations/figma.svg") },
  {
    id: "google-drive",
    label: "Google Drive",
    logoSrc: publicAsset("/images/integrations/google-drive.svg"),
  },
  { id: "excel", label: "Excel", logoSrc: publicAsset("/images/integrations/excel.svg") },
  {
    id: "apple-notes",
    label: "Apple Notes",
    logoSrc: publicAsset("/images/integrations/apple-notes.svg"),
  },
];

/**
 * Collect all icon URLs from the tool catalog for preloading.
 */
export function getAllToolIconUrls(): string[] {
  const urls: string[] = [];
  for (const tool of PRECHAT_TOOLS) {
    if (tool.logoSrc) urls.push(tool.logoSrc);
    if (tool.logoSrcDark) urls.push(tool.logoSrcDark);
  }
  return urls;
}

/**
 * Strip the `"other:"` prefix from custom tool ids before sending them to the
 * backend, dedupe, and sort ascending.
 *
 * Mirrors macOS `PreChatOnboardingFlow.swift:72-74`.
 */
export function stripOtherPrefix(toolIds: string[]): string[] {
  const cleaned = toolIds.map((id) =>
    id.startsWith("other:") ? id.slice("other:".length) : id,
  );
  return Array.from(new Set(cleaned)).sort();
}
