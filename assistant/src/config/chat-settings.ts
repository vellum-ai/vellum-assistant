import { z } from "zod";

import { isPlainObject } from "../util/object.js";
import { AutoArchiveConfigSchema } from "./schemas/conversations.js";
import { NotificationsConfigSchema } from "./schemas/notifications.js";

export const ChatSettingsConfigSchema = z.object({
  conversations: z
    .object({ autoArchive: AutoArchiveConfigSchema.optional() })
    .optional(),
  notifications: NotificationsConfigSchema.optional(),
});

export const ChatSettingsPatchSchema = z.object({
  conversations: z
    .object({
      autoArchive: z
        .object({
          enabled: AutoArchiveConfigSchema.shape.enabled
            .unwrap()
            .nullable()
            .optional(),
          afterDays: AutoArchiveConfigSchema.shape.afterDays
            .unwrap()
            .nullable()
            .optional(),
        })
        .passthrough()
        .nullable()
        .optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
  notifications: z
    .object({
      newMessageEnabled: NotificationsConfigSchema.shape.newMessageEnabled
        .unwrap()
        .nullable()
        .optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
});

export function scrubNulledChatSettings(raw: Record<string, unknown>): void {
  const conversations = raw.conversations;
  if (isPlainObject(conversations)) {
    const autoArchive = conversations.autoArchive;
    if (isPlainObject(autoArchive)) {
      for (const key of ["enabled", "afterDays"]) {
        if (autoArchive[key] === null) {
          delete autoArchive[key];
        }
      }
    }
  }
  const notifications = raw.notifications;
  if (
    isPlainObject(notifications) &&
    notifications.newMessageEnabled === null
  ) {
    delete notifications.newMessageEnabled;
  }
}
