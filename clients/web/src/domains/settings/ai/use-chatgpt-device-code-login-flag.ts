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
 * working sign-in and only ever swaps forward once the real value lands. The
 * section itself mounts from a user opening the provider editor, well after
 * flags settle.
 */
export function useChatgptDeviceCodeLogin(): boolean {
  return useClientFeatureFlagStore.use.chatgptDeviceCodeLogin();
}
