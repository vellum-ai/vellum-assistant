/**
 * How far one daemon read behind the chat-info panel has got, in the terms the
 * panel's status is built from. The apps list, the documents list, and the two
 * attachment lists all settle by this one rule, so a panel that reports pending
 * or failed means the same thing whichever source is speaking.
 */

import { onlineManager } from "@tanstack/react-query";

import { isTransientNetworkError } from "@/utils/is-transient-network-error";

export type DaemonSourceState = "ready" | "unresolved" | "failed";

/**
 * A network error thrown while the browser is offline is the one failure still
 * on its way: TanStack refetches every query on reconnect. The same error while
 * the browser is online is a refused connection that has already spent its
 * retries, and it settles like any other answer.
 */
function waitsForReconnect(error: Error | null): boolean {
  return isTransientNetworkError(error) && !onlineManager.isOnline();
}

/**
 * A failed background refetch keeps the last data, so a source is failed or
 * unresolved only while it has nothing to show. Of the errors that leave it
 * with nothing, only the one {@link waitsForReconnect} names is still coming.
 */
export function daemonSourceState(query: {
  data: unknown;
  isError: boolean;
  error: Error | null;
}): DaemonSourceState {
  if (query.data !== undefined) {
    return "ready";
  }
  if (query.isError && !waitsForReconnect(query.error)) {
    return "failed";
  }
  return "unresolved";
}

/** The worse of two sources: unresolved outranks failed, failed outranks ready. */
export function worstSourceState(
  first: DaemonSourceState,
  second: DaemonSourceState,
): DaemonSourceState {
  if (first === "unresolved" || second === "unresolved") {
    return "unresolved";
  }
  if (first === "failed" || second === "failed") {
    return "failed";
  }
  return "ready";
}
