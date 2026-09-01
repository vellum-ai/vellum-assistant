/**
 * The repair a notification carries, as state a renderer can place.
 *
 * A hook rather than a component because the button and its outcome belong in
 * different parts of the panel: the action sits in the footer's action group
 * with the other primary controls, while what happened to it reads with the
 * content above. A component owning both would have to render them together,
 * or reach across the panel to place them.
 *
 * Returns null when the item offers no repair, or offers one this build has
 * no handler for. Both are ordinary: most notifications report something no
 * client can act on, and a daemon may name a fix that shipped after this
 * client did.
 */
import { useCallback, useState } from "react";

import type { FeedItem } from "@vellumai/assistant-api";

import { resolveFeedRemediationHandler } from "./feed-remediation-registry";

export interface FeedRemediationController {
  /** Producer-authored button label, which names the outcome of the fix. */
  label: string;
  isRunning: boolean;
  /** True once the fix has succeeded, which retires the button. */
  isDone: boolean;
  /** Why the last attempt failed, or null. Shown to the reader verbatim. */
  error: string | null;
  run: () => void;
}

export function useFeedRemediation(
  item: Pick<FeedItem, "remediation">,
): FeedRemediationController | null {
  const [isRunning, setIsRunning] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remediation = item.remediation;
  const handler = remediation
    ? resolveFeedRemediationHandler(remediation.action)
    : null;

  const run = useCallback(() => {
    if (!handler) {
      return;
    }
    setIsRunning(true);
    setError(null);
    void handler()
      .then(() => {
        setIsDone(true);
      })
      .catch((cause: unknown) => {
        // The reason is the useful half: "sign in to Vellum" and "the
        // assistant is unreachable" need different things from the reader, and
        // a generic failure would hide which one happened.
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        setIsRunning(false);
      });
  }, [handler]);

  if (!remediation || !handler) {
    return null;
  }

  return { label: remediation.label, isRunning, isDone, error, run };
}
