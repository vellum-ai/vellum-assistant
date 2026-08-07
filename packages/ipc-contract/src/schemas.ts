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

import {
  ASSISTANT_STATUSES,
  NOTIFICATION_CATEGORIES,
  VOICE_ACTIVITY_CONTROL_ACTIONS,
  VOICE_ACTIVITY_PHASES,
} from "./types";

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

// ---------------------------------------------------------------------------
// Voice activity
// ---------------------------------------------------------------------------

/**
 * Derived from the `as const` vocabularies in `./types.ts` rather than
 * restated, so a phase or action added there is validated here without a
 * second edit and, more to the point, cannot be added there and silently
 * rejected at this boundary.
 */
export const voiceActivityPhaseSchema = z.enum(VOICE_ACTIVITY_PHASES);

export const voiceActivityContentSchema = z.object({
  phase: voiceActivityPhaseSchema,
  label: z.string(),
  accentHex: z.string(),
  muted: z.boolean(),
  outputMuted: z.boolean(),
  detail: z.string(),
  approvalRequestId: z.string(),
});

export const voiceActivityStartSchema = voiceActivityContentSchema.extend({
  assistantName: z.string(),
  avatarBase64: z.string().optional(),
});

export const voiceActivityControlActionSchema = z.enum(
  VOICE_ACTIVITY_CONTROL_ACTIONS,
);

export const voiceActivityControlSchema = z.object({
  action: voiceActivityControlActionSchema,
  requestId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Companion surface
// ---------------------------------------------------------------------------

/** See `CompanionTurn`: a side and some text, and deliberately nothing else. */
export const companionTurnSchema = z.object({
  role: z.union([z.literal("user"), z.literal("assistant")]),
  text: z.string(),
});

/**
 * The conversation tail the card draws.
 *
 * Capped at the boundary rather than trusted, because the publisher is a
 * renderer and this ends up in a window that floats over every other app. The
 * card scrolls, so the cap is what the user can plausibly scroll back through
 * on a floating panel rather than what fits on it.
 */
export const companionTurnsSchema = z.array(companionTurnSchema).max(40);

/** What the app's window tells main about the assistant the surface is for. */
export const companionContextSchema = z.object({
  assistantName: z.string(),
  turns: companionTurnsSchema,
});
