/**
 * What this client can do about a condition a notification reports.
 *
 * The producer names a fix on the feed item (`item.remediation`); this maps
 * that name to the work. Everything else about rendering a remediation is
 * shared, so a new one is an entry here and a branch in the daemon's
 * `deriveRemediation`, never a new card or a renderer that reads payload
 * fields to decide what button to draw.
 *
 * A handler owns only the doing. It reports failure by throwing, and the
 * message it throws is shown to the reader, so it should name the thing the
 * reader has to resolve (sign in, start the assistant) rather than an
 * internal cause.
 *
 * An action this build does not know renders nothing. That is what lets the
 * daemon add a remediation without waiting on every client to ship: an older
 * client shows the notification exactly as it does today.
 */
import { recoverLocalAssistantPlatformCredential } from "@/lib/local-platform-identity";
import type { FeedRemediationAction } from "@vellumai/assistant-api";

export type FeedRemediationHandler = () => Promise<void>;

const HANDLERS: Partial<Record<FeedRemediationAction, FeedRemediationHandler>> =
  {
    reprovision_managed_credential: async () => {
      await recoverLocalAssistantPlatformCredential();
    },
  };

/** The handler for `action`, or null when this build cannot perform it. */
export function resolveFeedRemediationHandler(
  action: string,
): FeedRemediationHandler | null {
  return HANDLERS[action as FeedRemediationAction] ?? null;
}
