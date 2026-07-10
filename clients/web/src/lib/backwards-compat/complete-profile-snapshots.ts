/**
 * Backwards-compat gate: complete-override profile snapshots.
 *
 * Vellum Assistant 0.10.8 (M6) completes custom profiles at write time:
 * fields left blank in the editor are baked with the current defaults and
 * no longer track later default changes. Older assistants still deep-merge
 * at resolution time, so blanks DO live-inherit there — the editor's
 * snapshot copy ("saved with the values shown") would be wrong and is
 * hidden against them.
 */
import { useAssistantSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.10.8";

export function useSupportsCompleteProfileSnapshots(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
