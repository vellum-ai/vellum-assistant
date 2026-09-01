/**
 * Once-per-page-load claim set for telemetry failure reporting.
 *
 * A telemetry failure is systemic, not per-event: it means this client emits
 * something a server contract refuses, so one Sentry report per condition
 * shows it and one per flush would flood. The session-ingest and daemon-relay
 * senders share this set so their dedup semantics cannot drift; conditions
 * are namespaced strings (`rejected:<status>`, `dropped:<reason>`,
 * `relay:<status>`) so the two senders cannot claim each other's.
 */
const reportedConditions = new Set<string>();

/**
 * Filters to the conditions not yet reported this page load and claims them,
 * per condition rather than per batch, so a condition that already fired
 * alone cannot fire again by arriving alongside a new one.
 */
export function claimUnreportedConditions(
  conditions: readonly string[],
): string[] {
  const fresh = conditions.filter(
    (condition) => !reportedConditions.has(condition),
  );
  for (const condition of fresh) {
    reportedConditions.add(condition);
  }
  return fresh;
}

export function __resetReportedConditionsForTests(): void {
  reportedConditions.clear();
}
