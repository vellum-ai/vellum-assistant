import type { SubagentRecord } from "../persistence/subagent-store.js";

/** Match the parent delivery contract: advisors and silent forks stay internal. */
export function isUserFacingSubagent(
  task: Pick<SubagentRecord, "role" | "isFork" | "sendResultToUser">,
): boolean {
  return (
    task.role !== "advisor" &&
    (task.isFork
      ? task.sendResultToUser === true
      : task.sendResultToUser !== false)
  );
}
