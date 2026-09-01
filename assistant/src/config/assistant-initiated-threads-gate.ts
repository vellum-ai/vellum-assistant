import { getAssistantFeatureFlagValue } from "./assistant-feature-flags.js";
import type { AssistantConfig } from "./schema.js";

const ASSISTANT_INITIATED_THREADS_FLAG_KEY =
  "assistant-initiated-threads" as const;

/**
 * Whether the conversations the assistant started on its own are split into
 * their own sidebar section instead of sitting in Chats.
 *
 * Read through {@link getAssistantFeatureFlagValue} rather than
 * `isAssistantFeatureFlagEnabled`, because the flag is string-valued: that
 * helper coerces with `!!`, and `!!"off"` is `true`, so the boolean form would
 * report the off arm as on.
 *
 * A read-side gate only. The rows exist either way — every notification
 * delivery has always materialized one (`notifications/conversation-pairing.ts`)
 * — so turning the flag off puts them back in Chats and takes the `assistant`
 * row out of the section index, with nothing to migrate in either direction.
 *
 * This is the *only* gate on the feature, which is why the flag is
 * assistant-scope rather than `both`. Clients render the section on the
 * presence of the index row, because that row is what says the daemon has
 * withheld those conversations from Chats. A second, client-side gate could
 * only ever hide a section whose rows have already been withheld — losing
 * those threads rather than reverting the feature — so there deliberately
 * isn't one.
 */
export function isAssistantInitiatedThreadsEnabled(
  config?: AssistantConfig,
): boolean {
  return (
    getAssistantFeatureFlagValue(
      ASSISTANT_INITIATED_THREADS_FLAG_KEY,
      config,
    ) === "on"
  );
}
