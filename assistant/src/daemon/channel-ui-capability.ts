/**
 * Minimal capability view {@link conversationSupportsDynamicUi} reads. The live
 * `Conversation` (whose fields are the richer `ChannelCapabilities`), the tool
 * executor's `ToolSetupContext`, and partial test doubles all satisfy it
 * structurally, so the helper stays a dependency-free leaf callable from any
 * layer without importing `Conversation`.
 */
export interface DynamicUiCapabilityView {
  readonly currentTurnChannelCapabilities?: {
    readonly supportsDynamicUi: boolean;
    readonly channel?: string;
  };
  readonly channelCapabilities?: {
    readonly supportsDynamicUi: boolean;
    readonly channel?: string;
  };
}

/**
 * Whether the conversation's connected client can render dynamic UI surfaces
 * for the current turn — `true` unless the channel explicitly lacks the
 * capability. Prefers the per-turn capabilities, falling back to the
 * conversation's structural channel capabilities (set at creation, so this is
 * reliable on every run path, including queue-drained turns that carry no
 * per-call options).
 *
 * Pure projection of the conversation's public capability state.
 */
export function conversationSupportsDynamicUi(
  conversation: DynamicUiCapabilityView,
): boolean {
  const caps =
    conversation.currentTurnChannelCapabilities ??
    conversation.channelCapabilities;
  return caps?.supportsDynamicUi !== false;
}

/**
 * Channels whose adapter can render inline tappable options — approval buttons
 * today, question option pickers next. Single source of truth: `resolveChannelCapabilities`
 * populates `ChannelCapabilities.supportsInlineOptions` from this, and the approval
 * delivery path reads it directly, so no feature re-hardcodes its own channel set.
 *
 * Distinct from `supportsDynamicUi` (which gates the app's dynamic-UI surfaces): a
 * text-only channel like Telegram renders inline buttons yet has no dynamic UI.
 */
const INLINE_OPTIONS_CHANNELS: ReadonlySet<string> = new Set([
  "telegram",
  "whatsapp",
  "slack",
]);

/**
 * Whether a channel's adapter can render inline tappable options. Pure
 * set-membership on the canonical channel id (no normalization).
 */
export function channelSupportsInlineOptions(channel: string): boolean {
  return INLINE_OPTIONS_CHANNELS.has(channel);
}

/**
 * Channels where a parked `ask_question` can be delivered as a guardian-request
 * card with tappable answer options — i.e. channels with a notification
 * adapter that renders card actions (`notifications/adapters/`). A strict
 * subset of {@link INLINE_OPTIONS_CHANNELS}: WhatsApp renders approval buttons
 * on direct sends but has no notification adapter yet, so parking a question
 * for it would hang the turn with no card ever delivered.
 *
 * Gates BOTH the `ask_question` park decision (tool context) and the
 * guardian-request promotion, so the two can never disagree. Onboarding a
 * channel = add its notification adapter, then add it here.
 */
const GUARDIAN_QUESTION_CARD_CHANNELS: ReadonlySet<string> = new Set([
  "telegram",
  "slack",
]);

/**
 * Whether a parked question can be delivered to this channel as a
 * guardian-request card. Pure set-membership on the canonical channel id.
 */
export function channelSupportsGuardianQuestionCards(channel: string): boolean {
  return GUARDIAN_QUESTION_CARD_CHANNELS.has(channel);
}

/**
 * Whether the conversation's current-turn channel can receive a parked
 * question as a guardian-request card. Opt-in per channel: defaults to
 * `false` when the channel is unknown. Prefers the per-turn capabilities,
 * falling back to the structural channel capabilities.
 */
export function conversationSupportsGuardianQuestionCards(
  conversation: DynamicUiCapabilityView,
): boolean {
  const caps =
    conversation.currentTurnChannelCapabilities ??
    conversation.channelCapabilities;
  return caps?.channel
    ? channelSupportsGuardianQuestionCards(caps.channel)
    : false;
}
