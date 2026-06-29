import type { ExternalConversationBinding } from "../persistence/external-conversation-store.js";
import type { ChannelBindingMetadata } from "./channel-binding-schema.js";
import { buildSlackBindingMetadata } from "./providers/slack/binding-metadata.js";

type BindingMetadataBuilder = (
  binding: ExternalConversationBinding,
) => ChannelBindingMetadata | undefined;

/**
 * Per-channel binding-metadata builders, keyed by source-channel id. A channel
 * that can enrich a serialized conversation binding (e.g. with deep links back
 * to the source message) registers its builder here; channels without an entry
 * contribute nothing.
 *
 * Wired statically on purpose: conversation serialization runs in contexts that
 * never boot the daemon (unit tests, CLI tooling), so this must not depend on
 * the lifecycle-registered messaging-provider registry.
 */
const BINDING_METADATA_BUILDERS: Record<string, BindingMetadataBuilder> = {
  slack: buildSlackBindingMetadata,
};

/**
 * Channel-specific fields to merge onto a serialized channel binding, or
 * `undefined` when the source channel contributes none.
 */
export function buildChannelBindingMetadata(
  binding: ExternalConversationBinding,
): ChannelBindingMetadata | undefined {
  return BINDING_METADATA_BUILDERS[binding.sourceChannel]?.(binding);
}
