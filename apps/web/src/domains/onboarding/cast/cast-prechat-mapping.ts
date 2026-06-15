/**
 * Field-mapping from the cast onboarding flow's collected selections into the
 * existing {@link PreChatOnboardingContext} handoff.
 *
 * This is the load-bearing translation that lets the cast (personal-page arm)
 * flow reuse the same pre-chat plumbing as the control funnel: the user's
 * role becomes their occupation, the jobs/tools they picked become the
 * selected tasks/tools, and the first chat message is overridden with the
 * research directive that kicks off the personal-page build.
 *
 * `CastSelections` is declared locally (rather than imported from the cast
 * roster types) so this mapping stays independent of the rest of the cast
 * flow and can be unit-tested in isolation. The defaults here may be
 * revisited once the real cast steps are wired up.
 */
import { DEFAULT_GROUP_ID } from "@/domains/onboarding/prechat-names";
import { buildPreChatContext } from "@/domains/onboarding/prechat-context";
import type { PreChatOnboardingContext } from "@/domains/onboarding/prechat";

/** Selections collected during the cast onboarding flow. */
export interface CastSelections {
  firstName?: string;
  lastName?: string;
  role?: string;
  tone?: string;
  jobs: string[];
  reachTools: string[];
  priorAssistant?: string;
  /**
   * The name the user gave their chosen cast assistant. Threaded into the
   * context's `assistantName` so the auto-sent onboarding payload carries it —
   * the daemon persists `IDENTITY.md` only when `onboarding.assistantName` is
   * present, so without this the chosen cast name would never be written.
   */
  assistantName?: string;
}

/**
 * The auto-sent first message for the cast/personal-page arm. Instead of a
 * canned greeting, it directs the assistant to research the user and build out
 * their personal-page app.
 */
export const CAST_RESEARCH_DIRECTIVE =
  "Research me based on my name and role, then build out my personal-page app with what you find.";

/**
 * Map cast selections into a {@link PreChatOnboardingContext} by delegating to
 * the shared {@link buildPreChatContext} builder, then overriding the initial
 * message with the research directive so the activation arm kicks off the
 * personal-page build rather than sending the default greeting.
 */
export function buildCastPreChatContext(
  sel: CastSelections,
): PreChatOnboardingContext {
  const context = buildPreChatContext({
    mode: "control",
    activationFlowEnabled: true,
    recipe: null,
    userName: [sel.firstName, sel.lastName].filter(Boolean).join(" "),
    occupation: sel.role,
    tone: sel.tone ?? DEFAULT_GROUP_ID,
    selectedTasks: new Set(sel.jobs),
    selectedTools: new Set(sel.reachTools),
    selectedPriorAssistants: sel.priorAssistant
      ? new Set([sel.priorAssistant])
      : new Set(),
    assistantName: sel.assistantName ?? "",
    selfIntroGreetingEnabled: false,
    googleConnected: false,
    googleScopes: [],
  });

  // buildPreChatContext sets initialMessage itself; the cast arm always sends
  // the research directive instead.
  context.initialMessage = CAST_RESEARCH_DIRECTIVE;
  return context;
}
