import { CastChatSandbox } from "@/cast/cast-chat-sandbox";

/**
 * Route wrapper for the onboarding chat. Mounted as an authed child of
 * `/assistant` (gets `authMiddleware` + RootLayout + all app providers/stores),
 * but outside ChatLayout so there's no chat sidebar. Navigable at
 * `/assistant/focus-chat` — intentionally off the `/assistant/onboarding/*`
 * prefix, which `navigation-resolver` redirects onboarded users away from.
 */
export function OnboardingChatRoute() {
  return <CastChatSandbox />;
}
