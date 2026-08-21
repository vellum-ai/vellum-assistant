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
  // Defaulted rather than required so a renderer that predates the field still
  // publishes a valid context: the tail it sends is worth drawing, and the
  // honest answer for a publisher that cannot report a turn is that it is not
  // reporting one.
  working: z.boolean().default(false),
  // Defaulted for the same reason `working` is: a publisher that runs no watch
  // session has nothing to report, and staying silent is its truthful answer.
  watching: z.boolean().default(false),
  // Left optional rather than defaulted, because this one has no resting value
  // to stand in for: `pending` and `ready` are both claims that something is
  // happening, and absence is the only way to say nothing is. See
  // `CompanionWatchRetro`.
  watchRetro: z.enum(["pending", "ready"]).optional(),
  // The running session's screen reads, counted. Bounded to a non-negative
  // integer at the boundary because the surface reads a step in it as a
  // capture having happened, and the only shape that can say that is a whole
  // number that goes up.
  captureCount: z.number().int().nonnegative().default(0),
});

// ---------------------------------------------------------------------------
// Windows title bar
// ---------------------------------------------------------------------------

/**
 * A CSS color in one of the notations Chromium's parser accepts: hex,
 * functional `rgb()` / `rgba()` / `hsl()` / `hsla()`, or a named color.
 * Bounded so an unparseable string is rejected at the boundary rather than
 * silently dropped by Electron, and so nothing unbounded reaches the store the
 * colors are persisted in.
 */
const cssColorSchema = z
  .string()
  .max(64)
  .regex(/^(#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([^()]*\)|[a-zA-Z]+)$/);

/** See `TitleBarOverlayTheme`: how the Windows caption buttons are painted. */
export const titleBarOverlayThemeSchema = z.object({
  color: cssColorSchema,
  symbolColor: cssColorSchema,
  colorScheme: z.enum(["light", "dark"]),
});
