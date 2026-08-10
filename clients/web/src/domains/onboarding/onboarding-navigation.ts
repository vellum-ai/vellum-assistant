/**
 * How the onboarding funnel moves between its own screens.
 *
 * The funnel is a wizard, and a wizard belongs in ONE history entry. Every step
 * — forward and back — replaces the current entry instead of pushing a new one,
 * so the whole journey (welcome → hosting → api-key → privacy → hatching →
 * research → chat) leaves exactly one entry behind, which the final handoff to
 * `/assistant` then replaces in turn.
 *
 * That is what makes Back inert after setup finishes. `replace: true` on the
 * handoff alone only ever dropped the LAST entry, so every earlier step stayed
 * on the stack and a single Back press landed a finished user back inside the
 * funnel — on `onboarding/start` in platform mode, `onboarding/hatching` in
 * local mode. Both are full-viewport takeovers whose only forward control
 * re-enters setup, so the user was stuck. Collapsing the funnel removes the
 * entries rather than guarding them: there is nothing behind chat to go back
 * to, so the browser's Back button is genuinely inert rather than bouncing
 * through a redirect.
 *
 * Nothing in the funnel reads the history stack — every in-screen "Back"
 * affordance navigates to a NAMED predecessor rather than `navigate(-1)` (a
 * deliberate choice: on a Capacitor staging shell a history-relative back could
 * leave the SPA for the marketing host and switch the app off its own
 * environment). So replacing costs the funnel nothing.
 *
 * The entry INTO the funnel is deliberately not covered here: the post-auth
 * landing already replaces, and the chooser's "Create a new assistant" pushes on
 * purpose so an onboarded user adding a second assistant can Back out to the
 * chooser they came from.
 */

import type { NavigateOptions } from "react-router";

export const SETUP_NAVIGATE: NavigateOptions = { replace: true };
