/**
 * Geometry + mime types shared across cast screens.
 *
 * Inlined from the prototype's `cast-hero` module (`@/cast/cast-hero`). The full
 * `cast-hero` component (Super-Saiyan aura, held props, etc.) is a marketing/demo
 * surface that is out of scope for the onboarding flow, so only the pure types it
 * exported are lifted here. Keeping them in their own file lets the orchestrator
 * and screen stubs share the geometry contract without pulling in the excluded
 * component closure.
 */

import type { Edge, RatherChoice } from "@/domains/onboarding/cast/cast-content";

/** A positioned square box (avatar / hero slot) in viewport pixels. */
export interface Rect {
  left: number;
  top: number;
  size: number;
}

/** A "rather" mime beat — a prop flying in from an edge, replayed on nonce bump. */
export interface MimeState {
  rather: RatherChoice;
  edge: Edge;
  nonce: number; // bump to replay
}
