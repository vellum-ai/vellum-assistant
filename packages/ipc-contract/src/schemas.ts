/**
 * Zod schemas for IPC payload types that main validates at the channel
 * boundary.
 *
 * Only types that flow renderer→main and are `.parse()`d / `.safeParse()`d
 * in a `handle()` or `on()` registration have schemas here. Types that
 * flow main→renderer (commands, hotkey catalogs, power events, etc.) are
 * plain TypeScript types in `./types.ts` — the renderer trusts main.
 *
 * Consumers:
 *   - Main: `import { assistantStatusSchema } from "@vellumai/ipc-contract"`
 *     → use in `handle()` / `on()` registrations.
 *   - Preload / renderer: type-only imports; schemas are never bundled
 *     into the preload or renderer.
 */
import { z } from "zod";

import { ASSISTANT_STATUSES, NOTIFICATION_CATEGORIES } from "./types";

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const assistantStatusSchema = z.enum(ASSISTANT_STATUSES);

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notificationCategorySchema = z.enum(NOTIFICATION_CATEGORIES);

export const showNotificationPayloadSchema = z.object({
  category: notificationCategorySchema,
  title: z.string(),
  body: z.string(),
  deliveryId: z.string().optional(),
  conversationId: z.string().optional(),
  toolCallId: z.string().optional(),
  deepLinkMetadata: z.record(z.string(), z.unknown()).optional(),
});
