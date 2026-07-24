import type { ScheduleMode } from "../../schedule/schedule-store.js";

/**
 * Appended to a schedule-tool result when a schedule will run mainAgent LLM
 * turns with no pinned inference profile. It is the judgement hook the
 * assistant reads to make a deliberate model choice and tell the user what the
 * schedule costs to run on an ongoing basis.
 *
 * Only `execute`-mode schedules invoke the mainAgent model and honor
 * `inference_profile` — `notify`/`script`/`workflow` runs never do, so the note
 * would be inaccurate for them.
 */
export const ACTIVE_MODEL_SELECTION_NOTE =
  "Model: this schedule's runs use the assistant's active chat-model selection. For routine recurring work (digests, inbox checks, reminders, status polls), pin a cost-efficient `inference_profile` to avoid compounding premium-model cost, and tell the user which model it will run on.";

/**
 * Whether to surface {@link ACTIVE_MODEL_SELECTION_NOTE} for a just
 * created/updated schedule: only when it runs mainAgent LLM turns (execute
 * mode) and no inference profile is pinned.
 */
export function shouldNoteActiveModelSelection(
  mode: ScheduleMode,
  inferenceProfile: string | null | undefined,
): boolean {
  return mode === "execute" && !inferenceProfile;
}
