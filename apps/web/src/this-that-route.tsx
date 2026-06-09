import { CastStylePage } from "@/cast/cast-style-page";

/**
 * Route wrapper for the standalone "This or That" page. Public & standalone (no
 * auth, no app chrome) like `/assistant/cast`, so a coworker can iterate on the
 * this/that selections (`cast-style.tsx`) in isolation at `/assistant/this-that`.
 */
export function ThisThatRoute() {
  return <CastStylePage />;
}
