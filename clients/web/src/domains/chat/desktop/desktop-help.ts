import type { PendingQuestionState } from "@/types/interaction-ui-types";

export function getDesktopHelpEntry(
  question: PendingQuestionState | null | undefined,
) {
  const entry = question?.entries[0];
  return question?.entries.length === 1 &&
    entry?.presentation === "virtual_desktop"
    ? entry
    : null;
}
