/**
 * Cast task derivation — the SOURCE OF TRUTH for the user's suggested tasks.
 *
 * Ported verbatim from the prototype's `interactive-setup.tsx` (the
 * `HandoffScreen` closure). The prototype's separate `job` phase is gone, so
 * `deriveTaskSuggestions` is now the single place tasks are computed: the
 * done/handoff screen renders them, and the downstream PreChatOnboardingContext
 * handoff maps its `tasks` from this output. Kept as a pure, dependency-free
 * module so it can be unit-tested and consumed by the orchestrator without
 * pulling in any React/screen closure.
 *
 * `deriveTaskSuggestions` reads the persistent "making of" memory list (the
 * `[step, text]` tuples recorded during onboarding): connected tools (the
 * `reach` entry) drive tool-specific tasks, an imported brain adds a
 * continuation task, and the rest are filled from generic fallbacks. The result
 * is always capped at three.
 */

/** Tool-specific task suggestions, keyed by the connected tool's slug. */
export const TOOL_TASKS: Record<string, string[]> = {
  "google-calendar": ["Check my schedule for today", "Block focus time this week"],
  "notion": ["Summarize my recent Notion updates", "Create a weekly planner page"],
  "linear": ["Show my open Linear issues", "Draft a sprint summary"],
  "github": ["Review my open pull requests", "Summarize recent commits"],
  "slack": ["Catch me up on unread Slack messages", "Draft a standup update"],
  "gmail": ["Summarize my unread emails", "Draft a follow-up email"],
  "figma": ["List recent Figma file changes", "Prepare design review notes"],
  "outlook": ["Check my Outlook calendar for today", "Summarize flagged emails"],
  "google-drive": ["Find my most recent shared docs", "Organize my Drive files"],
};

/** Generic tasks used to fill any remaining slots. */
export const FALLBACK_TASKS = [
  "Draft a daily plan for me",
  "Help me write a professional email",
  "Summarize a document for me",
  "Create a to-do list for this week",
  "Research a topic and brief me",
];

/**
 * Derive up to three suggested tasks from the onboarding memory list. Pulls one
 * task per connected tool, adds a continuation task when a brain was imported,
 * then tops up from `FALLBACK_TASKS`.
 */
export function deriveTaskSuggestions(memories: [string, string][]): string[] {
  const tasks: string[] = [];
  const memMap = new Map(memories);

  // Pull tasks from connected tools
  const reachText = memMap.get("reach") ?? "";
  if (reachText.startsWith("Connected:")) {
    const toolNames = reachText.replace("Connected: ", "").split(", ");
    for (const toolName of toolNames) {
      // Find key by label
      const key =
        toolName === "Google Calendar"
          ? "google-calendar"
          : toolName.toLowerCase().replace(/\s+/g, "-");
      const pool = TOOL_TASKS[key];
      if (pool) tasks.push(pool[Math.floor(Math.random() * pool.length)]);
    }
  }

  // If brain was imported, add a related task
  const brainText = memMap.get("brain") ?? "";
  if (brainText.includes("Import from:")) {
    tasks.push("Pick up where I left off with my previous conversations");
  }

  // Fill remaining slots from fallbacks
  const seen = new Set(tasks);
  for (const t of FALLBACK_TASKS) {
    if (tasks.length >= 3) break;
    if (!seen.has(t)) {
      tasks.push(t);
      seen.add(t);
    }
  }

  return tasks.slice(0, 3);
}

/**
 * The persistent "making of" step list. Ported from the prototype's
 * `interactive-setup.tsx`; the commented-out `brain`/`email` steps are kept as
 * the prototype left them. Used by the memory-list UI and as documentation of
 * which steps feed `deriveTaskSuggestions`.
 */
export const ALL_STEPS: { step: string; pending: string; credits?: number }[] = [
  { step: "face", pending: "Look & feel" },
  { step: "tone", pending: "Communication style" },
  // { step: "brain", pending: "Context import", credits: 50 },
  { step: "reach", pending: "Primary channel", credits: 25 },
  // { step: "email", pending: "Email address" },
];
