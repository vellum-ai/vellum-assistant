import { CastPage } from "@/cast/cast-page";

/**
 * Route wrapper for the Cast activation prototype. Standalone and public — no
 * auth middleware, no app chrome — so it can be navigated to directly at
 * `/assistant/cast` while it's still a prototype. Slated to fold into
 * onboarding later.
 */
export function CastPageRoute() {
  return <CastPage />;
}
