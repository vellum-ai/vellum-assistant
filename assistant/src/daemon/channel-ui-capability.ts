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
    readonly supportsInlineOptions?: boolean;
    readonly supportsInlineQuestions?: boolean;
  };
  readonly channelCapabilities?: {
    readonly supportsDynamicUi: boolean;
    readonly supportsInlineOptions?: boolean;
    readonly supportsInlineQuestions?: boolean;
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
 * Whether the conversation's current-turn channel can render inline tappable
 * options (question option pickers, approval buttons). Opt-in per channel:
 * defaults to `false` when unset (unlike dynamic UI, which defaults to
 * supported). Prefers the per-turn capabilities, falling back to the structural
 * channel capabilities.
 */
export function conversationSupportsInlineOptions(
  conversation: DynamicUiCapabilityView,
): boolean {
  const caps =
    conversation.currentTurnChannelCapabilities ??
    conversation.channelCapabilities;
  return caps?.supportsInlineOptions === true;
}

/**
 * Channels whose adapter renders the `ask_question` wizard as native inline
 * option buttons. A strict subset of {@link INLINE_OPTIONS_CHANNELS}: rendering
 * inline approval buttons (all of Telegram/Slack/WhatsApp) is a different, more
 * general capability than implementing the multi-step question wizard, which so
 * far only the Telegram adapter does. Onboarding another channel's question
 * wizard = build its renderer, then add it here — no shared-handling change.
 *
 * Kept distinct from `supportsInlineOptions` on purpose: gating questions on the
 * broader approval capability would park `ask_question` on Slack/WhatsApp with
 * no wizard to deliver it, hanging the turn until the response timeout instead
 * of degrading to the text fallback.
 */
const INLINE_QUESTION_CHANNELS: ReadonlySet<string> = new Set(["telegram"]);

/**
 * Whether a channel's adapter renders the `ask_question` wizard natively. Pure
 * set-membership on the canonical channel id (no normalization).
 */
export function channelSupportsInlineQuestions(channel: string): boolean {
  return INLINE_QUESTION_CHANNELS.has(channel);
}

/**
 * Whether the conversation's current-turn channel renders the `ask_question`
 * wizard natively. Opt-in per channel: defaults to `false` when unset. Prefers
 * the per-turn capabilities, falling back to the structural channel
 * capabilities.
 */
export function conversationSupportsInlineQuestions(
  conversation: DynamicUiCapabilityView,
): boolean {
  const caps =
    conversation.currentTurnChannelCapabilities ??
    conversation.channelCapabilities;
  return caps?.supportsInlineQuestions === true;
}
