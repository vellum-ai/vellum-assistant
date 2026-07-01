import type { ConversationListInvalidatedReason } from "../../api/events/conversation-list-invalidated.js";
import type { IdentityFields } from "../../daemon/handlers/identity.js";
import {
  conversationMessagesSyncTag,
  conversationMetadataSyncTag,
  SYNC_TAGS,
} from "../../daemon/message-types/sync.js";
import { getAvatarImagePath } from "../../util/platform.js";
import { broadcastMessage } from "../assistant-event-hub.js";
import { publishSyncInvalidation } from "./sync-publisher.js";

export function publishAvatarChanged(originClientId?: string): void {
  broadcastMessage({
    type: "avatar_updated",
    avatarPath: getAvatarImagePath(),
  });
  void publishSyncInvalidation([SYNC_TAGS.assistantAvatar], originClientId);
}

export function publishIdentityChanged(
  fields: IdentityFields,
  originClientId?: string,
): void {
  broadcastMessage({
    type: "identity_changed",
    name: fields.name,
    role: fields.role,
    personality: fields.personality,
    emoji: fields.emoji,
    home: fields.home,
  });
  void publishSyncInvalidation([SYNC_TAGS.assistantIdentity], originClientId);
}

export function publishConfigChanged(originClientId?: string): void {
  broadcastMessage({ type: "config_changed" });
  void publishSyncInvalidation([SYNC_TAGS.assistantConfig], originClientId);
}

export function publishSoundsConfigUpdated(originClientId?: string): void {
  broadcastMessage({ type: "sounds_config_updated" });
  void publishSyncInvalidation([SYNC_TAGS.assistantSounds], originClientId);
}

export function publishSchedulesChanged(originClientId?: string): void {
  void publishSyncInvalidation([SYNC_TAGS.assistantSchedules], originClientId);
}

export function publishAppsChanged(originClientId?: string): void {
  void publishSyncInvalidation([SYNC_TAGS.appsList], originClientId);
}

/**
 * Reasons that change the *shape* of the conversation list — a row is
 * added, removed, or its position changes. These require web clients to
 * refetch the paginated list because the row patch path (`refreshConversationRow`)
 * only handles a single known id. Reasons not in this set are *content-only*
 * changes to an existing row (e.g. `seen_changed`, `renamed`) and are
 * delivered exclusively via the per-conversation `sync_changed` tag, which
 * web consumes by GET-and-patching the single row.
 */
const SHAPE_CHANGING_REASONS: ReadonlySet<ConversationListInvalidatedReason> =
  new Set(["created", "deleted", "reordered"]);

/**
 * Publish the legacy `conversation_list_invalidated` broadcast to macOS
 * subscribers only.
 *
 * Web consumes `sync_changed` (`conversationsList` for shape changes,
 * `conversation:<id>:metadata` for content changes) directly and patches
 * the cached list in place — see `useConversationSync` for the consumer
 * side. macOS (`ConversationRestorer.swift`) still listens for the typed
 * broadcast.
 *
 * TODO(electron-cutover): remove this helper and all callers once macOS
 * migrates to the Electron client and consumes `sync_changed` directly.
 * At that point the `conversation_list_invalidated` message type can be
 * retired entirely.
 */
function broadcastConversationListInvalidatedToMacos(
  reason: ConversationListInvalidatedReason,
): void {
  broadcastMessage(
    {
      type: "conversation_list_invalidated",
      reason,
    },
    undefined,
    { targetInterfaceId: "macos" },
  );
}

export function publishConversationListChanged(
  reason: ConversationListInvalidatedReason,
  originClientId?: string,
): void {
  broadcastConversationListInvalidatedToMacos(reason);
  void publishSyncInvalidation([SYNC_TAGS.conversationsList], originClientId);
}

export function publishConversationMessagesChanged(
  conversationId: string,
  originClientId?: string,
): void {
  void publishSyncInvalidation(
    [conversationMessagesSyncTag(conversationId)],
    originClientId,
  );
}

export function publishConversationListAndMetadataChanged(
  reason: ConversationListInvalidatedReason,
  conversationIds: string | string[],
  originClientId?: string,
): void {
  const ids = Array.isArray(conversationIds)
    ? conversationIds
    : [conversationIds];
  broadcastConversationListInvalidatedToMacos(reason);

  // Shape-changing reasons (`created`, `deleted`, `reordered`) add or
  // remove rows or change the order of the paginated window — web must
  // refetch the list, so include the `conversationsList` umbrella tag.
  // Content-only reasons (`renamed`, `seen_changed`) modify an existing
  // row; web consumes the per-conversation metadata tag and GET-and-
  // patches the single row, avoiding the full paginated list drain
  // (`limit=50&offset=0..N` × foreground + background — ~14 requests
  // per write at a few hundred conversations).
  const tags: string[] = ids.map((conversationId) =>
    conversationMetadataSyncTag(conversationId),
  );
  if (SHAPE_CHANGING_REASONS.has(reason)) {
    tags.unshift(SYNC_TAGS.conversationsList);
  }
  void publishSyncInvalidation(tags, originClientId);
}

export function publishConversationTitleChanged(
  conversationId: string,
  title: string,
  originClientId?: string,
): void {
  broadcastMessage(
    {
      type: "conversation_title_updated",
      conversationId,
      title,
    },
    conversationId,
  );
  // Renames are content-only — the paired typed `conversation_title_updated`
  // event already carries the new title and patches the row in place on
  // web; macOS receives the per-interface `conversation_list_invalidated`
  // emitted from `broadcastMessage` (see `assistant-event-hub.ts`). The
  // `sync_changed` metadata tag is included as a belt-and-suspenders signal
  // for any sibling-tab consumer that missed the typed event.
  void publishSyncInvalidation(
    [conversationMetadataSyncTag(conversationId)],
    originClientId,
  );
}

export function publishConversationEnabledPluginsChanged(
  conversationId: string,
  originClientId?: string,
): void {
  void publishSyncInvalidation(
    [SYNC_TAGS.conversationsList, conversationMetadataSyncTag(conversationId)],
    originClientId,
  );
}

export function publishConversationInferenceProfileChanged(
  params: {
    conversationId: string;
    profile: string | null;
    sessionId?: string | null;
    expiresAt?: number | null;
  },
  originClientId?: string,
): void {
  broadcastMessage(
    {
      type: "conversation_inference_profile_updated",
      conversationId: params.conversationId,
      profile: params.profile,
      sessionId: params.sessionId,
      expiresAt: params.expiresAt,
    },
    params.conversationId,
  );
  void publishSyncInvalidation(
    [
      SYNC_TAGS.conversationsList,
      conversationMetadataSyncTag(params.conversationId),
    ],
    originClientId,
  );
}
