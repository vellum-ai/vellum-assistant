import type { ScheduleMode } from "../../schedule/schedule-store.js";

/**
 * Appended to a schedule-tool result when a recurring schedule will run
 * mainAgent LLM turns with no pinned inference profile. It is the judgement
 * hook the assistant reads to make a deliberate model choice and tell the user
 * what the schedule costs to run on an ongoing basis.
 *
 * Only `execute`-mode schedules invoke the mainAgent model and honor
 * `inference_profile` — `notify`/`script`/`workflow` runs never do, so the note
 * would be inaccurate for them. The cost guidance is about runs compounding
 * over time, so it applies to recurring schedules only — a one-shot (`fire_at`)
 * schedule fires once and carries no compounding cost.
 */
export const ACTIVE_MODEL_SELECTION_NOTE =
  "Model: this schedule's runs use the assistant's active chat-model selection. For routine recurring work (digests, inbox checks, reminders, status polls), pin a cost-efficient `inference_profile` to avoid compounding premium-model cost, and tell the user which model it will run on.";

/**
 * Whether to surface {@link ACTIVE_MODEL_SELECTION_NOTE} for a just
 * created/updated schedule: only when it is a recurring schedule that runs
 * mainAgent LLM turns (execute mode) with no inference profile pinned. One-shot
 * (`fire_at`) schedules are excluded — the note warns about compounding
 * recurring cost, which a single firing never incurs.
 */
export function shouldNoteActiveModelSelection(
  mode: ScheduleMode,
  inferenceProfile: string | null | undefined,
  isRecurring: boolean,
): boolean {
  return isRecurring && mode === "execute" && !inferenceProfile;
}
