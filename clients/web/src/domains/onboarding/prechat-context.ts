/**
 * Assemble the pre-chat onboarding handoff context from the answers collected
 * during the flow. Pure input→output: no React, no storage, no navigation —
 * the component owns those side effects and calls this to produce the payload.
 *
 * Both modes share one builder so the context shape can't drift between the
 * web control funnel and the native iOS flow.
 */
import type { OnboardingRecipe } from "@/domains/onboarding/recipe-client.js";
import {
  buildPreChatInitialMessage,
  DEFAULT_PRECHAT_INITIAL_MESSAGE,
  type PreChatOnboardingContext,
} from "@/domains/onboarding/prechat";
import { stripOtherPrefix } from "@/domains/onboarding/prechat-tools";

export const ACTIVATION_FLOW_COHORT = "experiment-activation-flow-2026-06-03";
export const ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE =
  "BOOTSTRAP-ACTIVATION-RAIL.md";

export type PreChatMode = "control" | "native";

export interface BuildPreChatContextInput {
  mode: PreChatMode;
  recipe: OnboardingRecipe | null;
  selectedTools: Set<string>;
  selectedTasks: Set<string>;
  selectedPriorAssistants: Set<string>;
  /** Already resolved: `selectedGroupId ?? recipe?.tone ?? DEFAULT_GROUP_ID`. */
  tone: string;
  userName: string;
  /** The user's role / occupation. Empty string when not collected. */
  occupation?: string;
  assistantName: string;
  selfIntroGreetingEnabled: boolean;
  /** Selects the activation rail bootstrap template for experiment users. */
  activationFlowEnabled?: boolean;
  /** Persisted Google connection state from a step the user already passed. */
  googleConnected: boolean;
  googleScopes: string[];
  /**
   * Scopes granted by the connect action that triggered this finish. Present
   * only when the user connected Google on the way out; `undefined` otherwise.
   */
  connectedScopes?: string[];
}

/**
 * The auto-sent first message. A campaign recipe wins; otherwise we greet by
 * name when the self-intro greeting flag is on, falling back to the default.
 */
function resolveInitialMessage(
  context: PreChatOnboardingContext,
  recipe: OnboardingRecipe | null,
  selfIntroGreetingEnabled: boolean,
): string {
  if (recipe?.initialMessage) {
    return recipe.initialMessage;
  }
  return selfIntroGreetingEnabled
    ? buildPreChatInitialMessage(context)
    : DEFAULT_PRECHAT_INITIAL_MESSAGE;
}

export function buildPreChatContext(
  input: BuildPreChatContextInput,
): PreChatOnboardingContext {
  const { mode, recipe } = input;
  const connectedWithCurrentAction = input.connectedScopes !== undefined;

  let context: PreChatOnboardingContext;
  if (mode === "native") {
    context = { tools: [], tasks: [], tone: input.tone, googleConnected: false };
  } else {
    context = {
      tools: stripOtherPrefix([...input.selectedTools]),
      tasks: [...input.selectedTasks].sort(),
      tone: input.tone,
    };
  }

  if (recipe) {
    context.cohort = recipe.cohort;
    context.bootstrapTemplate = recipe.bootstrapTemplate;
    context.skills = recipe.skills;
  }

  if (input.activationFlowEnabled) {
    context.cohort = ACTIVATION_FLOW_COHORT;
    context.bootstrapTemplate = ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE;
  }

  const trimmedUser = input.userName.trim();
  if (trimmedUser) context.userName = trimmedUser;
  const trimmedOccupation = input.occupation?.trim();
  if (trimmedOccupation) context.occupation = trimmedOccupation;
  const trimmedAssistant = input.assistantName.trim();
  if (trimmedAssistant) context.assistantName = trimmedAssistant;

  if (mode === "control") {
    if (connectedWithCurrentAction) {
      context.googleConnected = true;
      context.googleScopes = input.connectedScopes;
    } else if (input.googleConnected) {
      context.googleConnected = true;
      context.googleScopes = input.googleScopes;
    } else {
      context.googleConnected = false;
    }
  }

  if (mode === "control" && input.selectedPriorAssistants.size > 0) {
    context.priorAssistants = stripOtherPrefix([
      ...input.selectedPriorAssistants,
    ]);
  }

  context.initialMessage = resolveInitialMessage(
    context,
    input.activationFlowEnabled ? null : recipe,
    input.selfIntroGreetingEnabled,
  );
  return context;
}
