/**
 * Cast tool registry — the single source of truth for the OAuth tools the
 * dialogue "reach" phase offers and the per-tool task pools the done/handoff
 * screen suggests.
 *
 * Previously these lived in two places that had to agree by convention:
 * `screens/dialogue-screen.tsx` declared `REACH_TOOLS` (slug + label + icon +
 * keywords) and `cast-task-derivation.ts` declared `TOOL_TASKS` keyed by the
 * same slugs, with `deriveTaskSuggestions` reconstructing slugs from display
 * labels via a brittle string transform. Both now consume this registry:
 * `dialogue-screen.tsx` connects tools by `slug` (recorded in the memory list)
 * and `cast-task-derivation.ts` looks tasks up by that same slug, so there is no
 * label→slug round-trip.
 *
 * Kept pure and React-free (icons are described by asset path + alt, not a
 * rendered node) so the task-derivation module stays dependency-free and
 * unit-testable.
 */

/** A connectable tool: stable slug, display label, suggested tasks, and the
 * reach-phase picker presentation (keywords for context matching + icon). */
export interface CastTool {
  /** Stable identifier; never derived from the label. */
  slug: string;
  /** Display label shown in the reach picker and recorded in the memory list. */
  label: string;
  /** Suggested tasks for the done/handoff screen when this tool is connected. */
  tasks: string[];
  /** Keywords used to score this tool against the brain-import context. */
  keywords: string[];
  /** Reach-picker icon asset (relative to `publicAsset`). */
  icon: string;
}

/**
 * The tool catalog. `google-calendar` is the always-offered first reach tool;
 * the rest are candidates for the analysed second slot (see
 * `pickSecondReachTool` in `dialogue-screen.tsx`).
 */
export const CAST_TOOLS: CastTool[] = [
  {
    slug: "google-calendar",
    label: "Google Calendar",
    tasks: ["Check my schedule for today", "Block focus time this week"],
    keywords: ["calendar", "schedule", "meeting", "event", "appointment", "availability"],
    icon: "/images/integrations/google-calendar.svg",
  },
  {
    slug: "notion",
    label: "Notion",
    tasks: ["Summarize my recent Notion updates", "Create a weekly planner page"],
    keywords: ["notion", "notes", "wiki", "documentation", "docs", "database", "knowledge base", "writing"],
    icon: "/images/integrations/notion.svg",
  },
  {
    slug: "linear",
    label: "Linear",
    tasks: ["Show my open Linear issues", "Draft a sprint summary"],
    keywords: ["linear", "sprint", "issue", "ticket", "project management", "backlog", "roadmap", "kanban"],
    icon: "/images/integrations/linear-light-logo.svg",
  },
  {
    slug: "github",
    label: "GitHub",
    tasks: ["Review my open pull requests", "Summarize recent commits"],
    keywords: ["github", "code", "programming", "repo", "pull request", "commit", "developer", "engineering", "software"],
    icon: "/images/integrations/github.svg",
  },
  {
    slug: "slack",
    label: "Slack",
    tasks: ["Catch me up on unread Slack messages", "Draft a standup update"],
    keywords: ["slack", "team", "channel", "messaging", "chat", "standup", "communication"],
    icon: "/images/integrations/slack.svg",
  },
  {
    slug: "gmail",
    label: "Gmail",
    tasks: ["Summarize my unread emails", "Draft a follow-up email"],
    keywords: ["gmail", "email", "inbox", "newsletter", "outreach", "correspondence"],
    icon: "/images/integrations/gmail.svg",
  },
  {
    slug: "figma",
    label: "Figma",
    tasks: ["List recent Figma file changes", "Prepare design review notes"],
    keywords: ["figma", "design", "ui", "ux", "wireframe", "prototype", "mockup", "visual"],
    icon: "/images/integrations/figma.svg",
  },
  {
    slug: "outlook",
    label: "Outlook",
    tasks: ["Check my Outlook calendar for today", "Summarize flagged emails"],
    keywords: ["outlook", "microsoft", "office", "teams", "enterprise"],
    icon: "/images/integrations/outlook.png",
  },
  {
    slug: "google-drive",
    label: "Google Drive",
    tasks: ["Find my most recent shared docs", "Organize my Drive files"],
    keywords: ["drive", "files", "storage", "documents", "spreadsheet", "folder", "share", "upload"],
    icon: "/images/integrations/google-drive.svg",
  },
];

/** Tools eligible for the analysed second reach slot (everything but the
 * always-first Google Calendar). */
export const SECOND_REACH_TOOLS: CastTool[] = CAST_TOOLS.filter(
  (t) => t.slug !== "google-calendar",
);

/** Lookup by slug — the form recorded in the "Connected: …" memory list (the
 * reach picker connects tools by `slug`, and the orchestrator joins those slugs
 * into the memory text consumed by `deriveTaskSuggestions`). */
export const CAST_TOOL_BY_SLUG: ReadonlyMap<string, CastTool> = new Map(
  CAST_TOOLS.map((t) => [t.slug, t]),
);
