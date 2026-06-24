/**
 * Memory v3 — procedure-distillation prompt.
 *
 * Built per `ready` proc-candidate cluster by the distillation trigger
 * (`proc-distill-trigger.ts`) and handed to a guardian background agent run as
 * the wake hint. The agent reads the cluster's member candidate notes,
 * synthesizes the ONE canonical procedure they all describe — stripping the
 * task-specific noise that differs across the ≥ N traces — and registers it as
 * a managed skill via `scaffold_managed_skill`. The procedure then lives only
 * in the skill; the trigger deletes the candidate notes on success.
 *
 * The run executes under the memory-consolidation origin (guardian trust,
 * `vellum` channel), so the permission checker auto-approves
 * `skill_load skill-management` and `scaffold_managed_skill` without an
 * interactive prompt (the background run has no client to answer one).
 *
 * Kept under `prompts/` rather than inlined in the trigger so the prompt body
 * is reviewable on its own, mirroring the consolidation/sweep prompt
 * convention.
 */

/** The member candidate notes a distillation run synthesizes into a skill. */
export interface ProcDistillNote {
  /** The note's concept-page slug (its on-disk home). */
  slug: string;
  /** The note body — one observed trace of the procedure. */
  body: string;
}

export interface ProcDistillPromptInput {
  /** Stable, immutable skill id the agent must scaffold under. */
  skillId: string;
  /** The cluster's `goal:` identity phrase (what the procedure accomplishes). */
  goal: string;
  /** The member candidate notes — the ≥ N observed traces to synthesize. */
  notes: ProcDistillNote[];
}

/**
 * Render the distillation wake hint for one ready cluster. The agent is told
 * the exact `skill_id` to use (derived immutably from the goal upstream) so the
 * scaffolded skill is the stable link target future facts reference via
 * `skill:`.
 */
export function renderProcDistillPrompt(input: ProcDistillPromptInput): string {
  const traces = input.notes
    .map(
      (note, i) =>
        `--- Trace ${i + 1} (note ${note.slug}) ---\n${note.body.trim()}`,
    )
    .join("\n\n");

  return [
    "You are distilling a recurring procedure into a reusable skill.",
    "",
    `The user has performed this procedure several times. Its goal is:`,
    `  ${input.goal}`,
    "",
    "Below are the captured traces of that procedure — each is one observed",
    "run, recorded as a candidate note. They share the same goal but differ in",
    "task-specific detail (different inputs, a retry here, a skipped step",
    "there). Your job is to synthesize the ONE canonical procedure they all",
    "describe.",
    "",
    traces,
    "",
    "Steps:",
    "1. Read every trace above. Identify the stable, reusable shape of the",
    "   procedure — the steps that recur across the traces. Strip the",
    "   task-specific noise (concrete values, one-off detours, retries) so the",
    "   result generalizes to the next run.",
    "2. Load the skill-management skill: `skill_load skill-management`.",
    "3. Call `scaffold_managed_skill` with:",
    `   - skill_id: "${input.skillId}"  (use exactly this id — it is the stable`,
    "     link target and must not change)",
    "   - name: a short human-readable name for the procedure",
    "   - description: one sentence on when to use this skill",
    "   - body_markdown: the canonical procedure as clear, step-by-step",
    "     markdown instructions (it may invoke CLI commands or tools as steps)",
    "",
    "Author the skill body as durable instructions for a future run, not as a",
    "report of what happened in these traces. Do not include the raw traces or",
    "any one-off values. Scaffold exactly one skill, then stop.",
  ].join("\n");
}
