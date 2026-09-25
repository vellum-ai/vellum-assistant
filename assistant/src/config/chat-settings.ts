import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { isPlainObject } from "../util/object.js";
import { AutoArchiveConfigSchema } from "./schemas/conversations.js";
import { NotificationsConfigSchema } from "./schemas/notifications.js";

const ChatSettingsConfigSchema = z.object({
  conversations: z
    .object({ autoArchive: AutoArchiveConfigSchema.optional() })
    .optional(),
  notifications: NotificationsConfigSchema.optional(),
});

function readPath(value: unknown, path: readonly PropertyKey[]): unknown {
  for (const key of path) {
    if (!isPlainObject(value)) {
      return undefined;
    }
    value = Reflect.get(value, key);
  }
  return value;
}

export function validateChatSettingsWrite(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): { success: true } | { success: false; error: z.ZodError } {
  const result = ChatSettingsConfigSchema.safeParse(next);
  if (result.success) {
    return { success: true };
  }
  // Untouched legacy values must not block unrelated writes or partial repairs.
  const issues = result.error.issues.filter(
    (issue) =>
      !isDeepStrictEqual(
        readPath(previous, issue.path),
        readPath(next, issue.path),
      ),
  );
  return issues.length > 0
    ? { success: false, error: new z.ZodError(issues) }
    : { success: true };
}

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

export function scrubNulledChatSettings(
  raw: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
  for (const path of [
    ["conversations"],
    ["notifications"],
    ["conversations", "autoArchive"],
    ["conversations", "autoArchive", "enabled"],
    ["conversations", "autoArchive", "afterDays"],
    ["notifications", "newMessageEnabled"],
  ]) {
    if (readPath(patch, path) !== null) {
      continue;
    }
    const parent = readPath(raw, path.slice(0, -1));
    if (isPlainObject(parent)) {
      delete parent[path[path.length - 1]!];
    }
  }
}
