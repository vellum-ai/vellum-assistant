import type { ModeSession } from "../api/mode-session.js";
import { getLogger } from "../util/logger.js";
import type {
  ConversationModeSessionCoordinator,
  ModeSessionSourceHandle,
} from "./conversation-mode-session.js";

const log = getLogger("mode-session-tracking");

/** Optional bookkeeping must not interrupt accepted actions or content. */
export function bestEffortModeSessionTracking<T>(
  operation: string,
  track: () => T,
): T | undefined {
  try {
    return track();
  } catch (err) {
    log.warn({ err, operation }, "Mode-session tracking failed");
    return undefined;
  }
}

/** Retire a refused source while already accepted turn output keeps its owner. */
export function claimModeSessionTurn(
  coordinator: Pick<
    ConversationModeSessionCoordinator,
    "claimTurn" | "retireSource"
  >,
  turnId: string,
  handle: ModeSessionSourceHandle,
  at: number,
): ModeSession | undefined {
  let owner: ModeSession | undefined;
  try {
    owner = coordinator.claimTurn(turnId, handle, at);
  } catch (err) {
    bestEffortModeSessionTracking("failed admission cleanup", () =>
      coordinator.retireSource(handle, {
        status: "interrupted",
        endReason: "tracking_failed",
      }),
    );
    throw err;
  }
  if (!owner || owner.id !== handle.id) {
    bestEffortModeSessionTracking("refused admission cleanup", () =>
      coordinator.retireSource(handle, {
        status: "interrupted",
        endReason: "tracking_refused",
      }),
    );
  }
  return owner;
}
