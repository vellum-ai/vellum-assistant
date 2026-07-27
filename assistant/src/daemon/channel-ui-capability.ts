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
  };
  readonly channelCapabilities?: { readonly supportsDynamicUi: boolean };
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
