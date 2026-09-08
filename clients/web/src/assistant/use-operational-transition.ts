import { useEffect, useState } from "react";

import type { AssistantOperationalStatus } from "./operational-status";

type TransitionState = "restarting" | "upgrading_assistant_version";

interface RecentTransition {
  assistantId: string;
  state: TransitionState;
}

function transitionState(state: string | undefined): TransitionState | null {
  switch (state) {
    case "restarting":
    case "restart":
      return "restarting";
    case "upgrading_assistant_version":
    case "upgrade_assistant_version":
      return "upgrading_assistant_version";
    default:
      return null;
  }
}

/** Keep a known restart or upgrade visible through a bounded health gap. */
export function useOperationalTransition(
  assistantId: string | null,
  status: AssistantOperationalStatus | null | undefined,
  isError: boolean,
): TransitionState | null {
  const [recent, setRecent] = useState<RecentTransition | null>(null);
  const [expired, setExpired] = useState<RecentTransition | null>(null);
  const failed =
    status?.detail_state === "failed" ||
    status?.active_operation?.phase === "failed";
  const healthGap =
    isError ||
    status?.state === "crash_loop" ||
    status?.state === "unreachable";
  const reportedTransition = transitionState(status?.state);
  const markerTransition = transitionState(status?.active_operation?.operation);

  const knownTransition =
    reportedTransition ?? (healthGap ? markerTransition : null);

  useEffect(() => {
    if (!assistantId || failed || (!healthGap && !knownTransition)) {
      setRecent(null);
    } else if (!isError && knownTransition) {
      setRecent((previous) =>
        previous?.assistantId === assistantId &&
        previous.state === knownTransition
          ? previous
          : { assistantId, state: knownTransition },
      );
    } else {
      setRecent((previous) =>
        previous?.assistantId === assistantId ? previous : null,
      );
    }
  }, [assistantId, failed, healthGap, isError, knownTransition]);

  const candidate = failed
    ? null
    : (reportedTransition ??
      markerTransition ??
      (recent?.assistantId === assistantId ? recent.state : null));
  const graceExpired =
    expired?.assistantId === assistantId && expired?.state === candidate;

  useEffect(() => {
    if (!healthGap) {
      setExpired(null);
      return;
    }
    if (!assistantId || !candidate || graceExpired) {
      return;
    }
    // One deadline across failed polls and alternating health errors.
    const timeout = setTimeout(() => {
      setExpired({ assistantId, state: candidate });
    }, 60_000);
    return () => clearTimeout(timeout);
  }, [assistantId, candidate, graceExpired, healthGap]);

  return assistantId && healthGap && !graceExpired ? candidate : null;
}
