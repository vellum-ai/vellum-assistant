/**
 * Onboarding-owned "first message" send for the cast flow.
 *
 * The cast flow fires its research directive at the assistant right after the
 * user finishes the name/occupation step, so the research runs in the
 * background while they walk the rest of onboarding. The chat domain's
 * `postChatMessage` can't be imported here (`local/no-cross-domain-imports`),
 * but every primitive it relies on is domain-neutral or onboarding-owned, so
 * this mirrors its happy path: build the wire body, attach the (normalized)
 * onboarding payload, seed the profile, POST, and return the server-minted
 * conversation id. The flow then lands the user in that same conversation when
 * onboarding completes.
 */
import { messagesPost } from "@/generated/daemon/sdk.gen";
import type { MessagesPostData } from "@/generated/daemon/types.gen";
import { pickConversationIdWireField } from "@/lib/backwards-compat/conversation-id-wire-field";
import { supportsServerMintedConversation } from "@/lib/backwards-compat/server-minted-conversation";
import { captureError } from "@/lib/sentry/capture-error";
import { getEffectiveTimezone } from "@/utils/effective-timezone";
import {
  normalizePreChatOnboardingContext,
  type PreChatOnboardingContext,
} from "@/domains/onboarding/prechat";
import { persistPreChatOnboardingProfile } from "@/domains/onboarding/prechat-profile";

const SEND_FAILED = "Failed to start your assistant. Please try again.";

/**
 * Send `content` as the first message of a new conversation with `assistantId`,
 * attaching `onboarding` (so the daemon seeds occupation, etc.). Returns the
 * conversation id the assistant minted (or echoed). Throws on any failure so
 * the caller can surface a retry affordance.
 */
export async function sendCastResearchMessage(
  assistantId: string,
  content: string,
  onboarding: PreChatOnboardingContext,
): Promise<string> {
  // Server-mint when the daemon supports it (omit both wire fields); otherwise
  // fall back to a client-generated draft id on the legacy create-or-lookup
  // path. Mirrors `postChatMessage`'s conversation-id wire-field selection.
  const conversationId = supportsServerMintedConversation()
    ? null
    : crypto.randomUUID();

  const body: MessagesPostData["body"] = {
    content,
    sourceChannel: "vellum",
    interface: "vellum",
  };
  const clientTimezone = getEffectiveTimezone();
  if (clientTimezone) body.clientTimezone = clientTimezone;
  const conversationField = pickConversationIdWireField();
  if (conversationId !== null || conversationField !== "conversationId") {
    body[conversationField] = conversationId;
  }

  // Mirror `chat/api/messages.ts` `postChatMessage` field-for-field — this IS
  // the activation arm's first message, so the daemon installs the activation
  // rail from `onboarding.bootstrapTemplate` and marks the activation session
  // from `cohort` here; dropping those (or the other optional fields) would
  // silently skip the bootstrap.
  const normalized = normalizePreChatOnboardingContext(onboarding);
  const onboardingDict: NonNullable<MessagesPostData["body"]["onboarding"]> = {
    tools: normalized.tools,
    tasks: normalized.tasks,
    tone: normalized.tone,
  };
  if (normalized.userName !== undefined)
    onboardingDict.userName = normalized.userName;
  if (normalized.occupation !== undefined)
    onboardingDict.occupation = normalized.occupation;
  if (normalized.assistantName !== undefined)
    onboardingDict.assistantName = normalized.assistantName;
  if (normalized.googleConnected !== undefined)
    onboardingDict.googleConnected = normalized.googleConnected;
  if (normalized.googleScopes !== undefined)
    onboardingDict.googleScopes = normalized.googleScopes;
  if (normalized.priorAssistants !== undefined)
    onboardingDict.priorAssistants = normalized.priorAssistants;
  if (normalized.cohort !== undefined)
    onboardingDict.cohort = normalized.cohort;
  if (normalized.bootstrapTemplate !== undefined)
    onboardingDict.bootstrapTemplate = normalized.bootstrapTemplate;
  if (normalized.initialMessage !== undefined)
    onboardingDict.initialMessage = normalized.initialMessage;
  if (normalized.skills !== undefined) onboardingDict.skills = normalized.skills;
  body.onboarding = onboardingDict;

  // Seed the onboarding profile files (occupation → users/default.md) — fire
  // and forget, same as `postChatMessage`.
  void persistPreChatOnboardingProfile(assistantId, normalized).catch((err) =>
    captureError(err, { context: "castResearchProfile" }),
  );

  const { data, response } = await messagesPost({
    path: { assistant_id: assistantId },
    body,
    throwOnError: false,
  });

  if (
    !response?.ok ||
    !data?.accepted ||
    typeof data.conversationId !== "string"
  ) {
    throw new Error(SEND_FAILED);
  }
  return data.conversationId;
}
