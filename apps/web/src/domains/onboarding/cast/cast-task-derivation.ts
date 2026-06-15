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
 *
 * Tool slugs and task pools come from the shared `cast-tools` registry
 * (`CAST_TOOL_BY_SLUG`), so the connected-tool slugs recorded in the memory
 * list resolve to tasks by direct lookup — no label→slug string transform.
 */

import { CAST_TOOL_BY_SLUG } from "@/domains/onboarding/cast/cast-tools";

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
    const toolSlugs = reachText.replace("Connected: ", "").split(", ");
    for (const slug of toolSlugs) {
      const pool = CAST_TOOL_BY_SLUG.get(slug)?.tasks;
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
