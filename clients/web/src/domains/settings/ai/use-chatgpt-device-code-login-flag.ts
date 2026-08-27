/**
 * Read seam for the `chatgpt-device-code-login` client flag, which decides
 * which sign-in the ChatGPT subscription connect section leads with: the
 * device code the user types at ChatGPT's own page, or the redirect-and-paste
 * flow that hands the daemon the callback URL.
 */

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/**
 * No pending state to wait on: the flag defaults off and a `false` read renders
 * the redirect-and-paste flow, so the pre-hydration window already shows a
 * working sign-in. Callers latch the value they read at mount rather than
 * following it, because a sign-in already under way must not be swapped out
 * from under the user when the settled value lands.
 */
export function useChatgptDeviceCodeLogin(): boolean {
  return useClientFeatureFlagStore.use.chatgptDeviceCodeLogin();
}
