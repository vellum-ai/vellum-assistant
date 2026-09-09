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
  const value = getAssistantFeatureFlagValue(
    ASSISTANT_INITIATED_THREADS_FLAG_KEY,
    config,
  );
  /* Both shapes are the same answer, and the on arm arrives as either one
     depending on which layer resolved it.

     The registry and the gateway's persisted store carry the declared string
     (`"on"`). The gateway's env-override path does not: its parser treats
     `on` as a truthy word (`TRUTHY = {"true","1","yes","on"}` in
     `feature-flag-env-overrides.ts`) and coerces it to boolean `true`, then
     applies env last — so `VELLUM_FLAG_ASSISTANT_INITIATED_THREADS=on`
     reaches the daemon as `true`, not `"on"`.

     A strict `=== "on"` therefore reads the env kill-switch as OFF, which is
     the exact opposite of what an operator setting it intends, and it fails
     silently: the section simply does not render. Accept both. */
  return value === true || value === "on";
}
