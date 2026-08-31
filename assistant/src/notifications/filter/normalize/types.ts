/**
 * The common record every notification source is mapped into, so rules and the
 * judgment layer can reason about notifications from Slack, Gmail, Linear and
 * the rest uniformly.
 *
 * Null is a first-class value here. An adapter fills in what its source
 * actually provides and leaves the rest null: Linear assignments have no human
 * sender, Slack container display names arrive after the item does, Gmail's
 * poll yields a snippet but no body. A rule that matches on a field a source
 * never populates simply does not match that source.
 */

import { z } from "zod";

import type { WatcherItem } from "../../../watcher/provider-types.js";

export const NotificationCategorySchema = z.enum([
  "dm",
  "mention",
  "assignment",
  "reply",
  "fyi",
  "broadcast",
]);

export type NotificationCategory = z.infer<typeof NotificationCategorySchema>;

export const NotificationSourceSchema = z.enum([
  "slack",
  "gmail",
  "linear",
  "github",
  "outlook",
  "os",
]);

export type NotificationSource = z.infer<typeof NotificationSourceSchema>;

/**
 * Who sent it. `null` when the source has no human sender at all (a Linear
 * status change), as opposed to a sender whose individual fields are unknown.
 */
export const NotificationSenderSchema = z.object({
  /** Source-native identifier (email address, Slack user id). */
  rawId: z.string().nullable(),
  displayName: z.string().nullable(),
  /** Local contact row id when the sender resolves to a known contact. */
  contactId: z.string().nullable(),
});

export type NotificationSender = z.infer<typeof NotificationSenderSchema>;

/** Where it landed: a Slack channel, an email thread, a Linear project. */
export const NotificationContainerSchema = z.object({
  type: z.enum(["channel", "thread", "project", "inbox"]),
  id: z.string(),
  displayName: z.string().nullable(),
});

export type NotificationContainer = z.infer<typeof NotificationContainerSchema>;

export const NotificationContentSchema = z.object({
  /** Always present: the cheap text every source can supply without a second call. */
  preview: z.string().min(1),
  /** Full body when the source hands it over for free, otherwise null until `fetchFull`. */
  full: z.string().nullable(),
  category: NotificationCategorySchema,
});

export const NotificationMetaSchema = z.object({
  /** Epoch milliseconds. */
  timestamp: z.number(),
  /** Source-native priority label (Linear priority, Gmail importance), verbatim. */
  nativePriority: z.string().nullable(),
  threadReplyCount: z.number().nullable(),
  hasAttachments: z.boolean().nullable(),
});

export const NormalizedNotificationSchema = z.object({
  source: NotificationSourceSchema,
  externalId: z.string(),
  sender: NotificationSenderSchema.nullable(),
  container: NotificationContainerSchema.nullable(),
  content: NotificationContentSchema,
  meta: NotificationMetaSchema,
});

export type NormalizedNotification = z.infer<
  typeof NormalizedNotificationSchema
>;

/** Maps one source's raw watcher items into `NormalizedNotification`. */
export interface NotificationNormalizer {
  source: NormalizedNotification["source"];

  /**
   * Map a raw watcher item. Return null to drop it entirely (not a tier
   * decision). Implementations are pure and must not perform network I/O:
   * normalization runs on every polled item, filtering happens afterwards.
   */
  normalize(item: WatcherItem): NormalizedNotification | null;

  /**
   * Fetch full content on demand. Absent when the source has no cheaper
   * preview, meaning its poll already returned the full content and
   * `content.full` is populated by `normalize`. Present only where the body
   * costs an extra API call (Gmail's poll yields a snippet), which is why the
   * judgment layer tiers on the preview first. Returns null on failure.
   */
  fetchFull?(item: NormalizedNotification): Promise<string | null>;
}
