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
import {
  type FeedRemediationAction,
  FeedRemediationActionSchema,
} from "@vellumai/assistant-api";

/**
 * Performs one fix. Receives the item's `params`, which name the instance to
 * repair; a handler for a condition that can only occur once ignores them.
 *
 * Reports failure by throwing, and the message it throws is shown to the
 * reader, so it names the thing the reader has to resolve (sign in, start the
 * assistant) rather than an internal cause.
 */
export type FeedRemediationHandler = (
  params: Record<string, string>,
) => Promise<void>;

const HANDLERS: Partial<Record<FeedRemediationAction, FeedRemediationHandler>> =
  {
    // A workspace has exactly one managed inference credential, so this fix
    // needs no parameters to say which one it repairs.
    reprovision_managed_credential: async () => {
      await recoverLocalAssistantPlatformCredential();
    },
  };

/**
 * The handler for `action`, or null when this build cannot perform it.
 *
 * The action arrives as a wire string that may name a remediation added after
 * this client shipped, so it is parsed against the schema that defines the
 * set rather than asserted into it.
 */
export function resolveFeedRemediationHandler(
  action: string,
): FeedRemediationHandler | null {
  const parsed = FeedRemediationActionSchema.safeParse(action);
  return parsed.success ? (HANDLERS[parsed.data] ?? null) : null;
}
