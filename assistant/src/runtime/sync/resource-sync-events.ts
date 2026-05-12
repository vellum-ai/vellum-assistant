import type { IdentityFields } from "../../daemon/handlers/identity.js";
import { SYNC_TAGS } from "../../daemon/message-types/sync.js";
import { getAvatarImagePath } from "../../util/platform.js";
import { broadcastMessage } from "../assistant-event-hub.js";
import { publishSyncInvalidation } from "./sync-publisher.js";

export function publishAvatarChanged(): void {
  broadcastMessage({
    type: "avatar_updated",
    avatarPath: getAvatarImagePath(),
  });
  void publishSyncInvalidation([SYNC_TAGS.assistantAvatar]);
}

export function publishIdentityChanged(fields: IdentityFields): void {
  broadcastMessage({
    type: "identity_changed",
    name: fields.name,
    role: fields.role,
    personality: fields.personality,
    emoji: fields.emoji,
    home: fields.home,
  });
  void publishSyncInvalidation([SYNC_TAGS.assistantIdentity]);
}
