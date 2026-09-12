/**
 * Zod schemas for IPC payload types that main validates at the channel
 * boundary.
 *
 * Types that flow renderer→main and are `.parse()`d / `.safeParse()`d in a
 * `handle()` or `on()` registration have schemas here. Most types that flow
 * main→renderer (commands, hotkey catalogs, power events, etc.) are plain
 * TypeScript types in `./types.ts`; the renderer trusts main.
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
  COMPANION_ANNOTATION_MAX_POINTS,
  COMPANION_ANNOTATION_TOOLS,
  COMPANION_COACHMARK_CAPTION_MAX,
  COMPANION_DICTATION_TAIL,
  NOTIFICATION_AVATAR_BASE64_MAX_CHARS,
  NOTIFICATION_AVATAR_HASH_PATTERN,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_DELIVERY_KEY_MAX_CHARS,
  NOTIFICATION_IDENTITY_MAX_CHARS,
  NOTIFICATION_NAME_PROVENANCES,
  NOTIFICATION_PRESENTATIONS,
  NOTIFICATION_SENDER_NAME_MAX_CHARS,
  VERIFIED_NOTIFICATION_NAME_PROVENANCES,
  VOICE_ACTIVITY_CONTROL_ACTIONS,
  VOICE_ACTIVITY_PHASES,
  COMPANION_DICTATION_OFFER_MAX,
} from "./types";

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const assistantStatusSchema = z.enum(ASSISTANT_STATUSES);

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notificationCategorySchema = z.enum(NOTIFICATION_CATEGORIES);

const boundedIdentityString = z
  .string()
  .trim()
  .min(1)
  .max(NOTIFICATION_IDENTITY_MAX_CHARS);
const boundedDeliveryString = z
  .string()
  .max(NOTIFICATION_DELIVERY_KEY_MAX_CHARS);
const notificationAvatarBase64Schema = z
  .string()
  .min(4)
  .max(NOTIFICATION_AVATAR_BASE64_MAX_CHARS)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

export const notificationIdentitySchema = z.object({
  scopeId: boundedIdentityString,
  assistantId: boundedIdentityString,
  nativeSenderId: boundedIdentityString,
});

const notificationAvatarSchema = z.object({
  avatarBase64: notificationAvatarBase64Schema,
  avatarHash: z.string().regex(NOTIFICATION_AVATAR_HASH_PATTERN),
});

/**
 * The hash names the file a host writes the avatar to, so the boundary that
 * accepts it is where "64 lowercase hex characters" has to be true: anything
 * else could escape the cache directory. The picture is bounded too, since
 * main decodes it and writes it to disk.
 */
const notificationSenderSchema = z.object({
  id: boundedIdentityString,
  name: z.string().trim().min(1).max(NOTIFICATION_SENDER_NAME_MAX_CHARS),
  avatarBase64: notificationAvatarBase64Schema,
  avatarHash: z.string().regex(NOTIFICATION_AVATAR_HASH_PATTERN),
});

export const prepareNotificationIdentityPayloadSchema = z
  .object({
    identity: notificationIdentitySchema,
    scopeEpoch: z.number().int().nonnegative().safe(),
    identityRevision: z.number().int().nonnegative().safe(),
    publisherSessionId: boundedIdentityString.optional(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(NOTIFICATION_SENDER_NAME_MAX_CHARS)
      .optional(),
    nameProvenance: z.enum(VERIFIED_NOTIFICATION_NAME_PROVENANCES).optional(),
    avatar: notificationAvatarSchema.optional(),
  })
  .superRefine((value, context) => {
    if (!value.name && !value.avatar) {
      context.addIssue({
        code: "custom",
        message: "A prepared identity requires a name or avatar",
      });
    }
    if (Boolean(value.name) !== Boolean(value.nameProvenance)) {
      context.addIssue({
        code: "custom",
        message: "Prepared names require verified provenance",
        path: ["nameProvenance"],
      });
    }
  });

export const resetNotificationIdentitiesPayloadSchema = z
  .object({
    scopeId: boundedIdentityString,
    scopeEpoch: z.number().int().nonnegative().safe(),
    publisherSessionId: boundedIdentityString.optional(),
    assistantId: boundedIdentityString.optional(),
    identityRevision: z.number().int().nonnegative().safe().optional(),
  })
  .superRefine((value, context) => {
    if (value.identityRevision !== undefined && !value.assistantId) {
      context.addIssue({
        code: "custom",
        message: "An identity revision requires a targeted assistant reset",
        path: ["identityRevision"],
      });
    }
  });

export const registerNotificationIdentityPublisherPayloadSchema = z.object({
  publisherSessionId: boundedIdentityString,
});

export const showNotificationPayloadSchema = z
  .object({
    category: notificationCategorySchema,
    title: z.string(),
    body: z.string(),
    deliveryId: boundedDeliveryString.optional(),
    conversationId: z.string().max(NOTIFICATION_IDENTITY_MAX_CHARS).optional(),
    toolCallId: z.string().max(NOTIFICATION_IDENTITY_MAX_CHARS).optional(),
    deepLinkMetadata: z.record(z.string(), z.unknown()).optional(),
    correlationId: boundedDeliveryString.optional(),
    requestKey: boundedDeliveryString.optional(),
    presentation: z.enum(NOTIFICATION_PRESENTATIONS).optional(),
    identity: notificationIdentitySchema.optional(),
    nameProvenance: z.enum(NOTIFICATION_NAME_PROVENANCES).optional(),
    suppressGroupTitle: z.boolean().optional(),
    /**
     * A malformed decoration degrades to no decoration. `handle()` parses this
     * payload and a throw rejects the renderer's `invoke`, so a strict field
     * here would cost the user the banner itself rather than its avatar.
     */
    sender: notificationSenderSchema.optional().catch(undefined),
  })
  .superRefine((value, context) => {
    if (
      value.identity &&
      value.sender &&
      value.identity.nativeSenderId !== value.sender.id
    ) {
      context.addIssue({
        code: "custom",
        message: "Sender and routing identity must match",
        path: ["sender", "id"],
      });
    }
    if (value.nameProvenance && value.presentation !== "assistant") {
      context.addIssue({
        code: "custom",
        message: "Name provenance requires assistant presentation",
        path: ["nameProvenance"],
      });
    }
    if (value.suppressGroupTitle && value.nameProvenance !== "title") {
      context.addIssue({
        code: "custom",
        message: "Group title suppression requires title provenance",
        path: ["suppressGroupTitle"],
      });
    }
  });

// ---------------------------------------------------------------------------
// Window attention
// ---------------------------------------------------------------------------

export const windowAttentionPayloadSchema = z.object({
  visible: z.boolean(),
  focused: z.boolean(),
  minimized: z.boolean(),
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

/**
 * A display or a window, by the ids the window server names them. Whole
 * numbers, since both ids are unsigned integers on the host and anything else
 * names nothing.
 */
export const watchCaptureTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("display"),
    displayId: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("window"),
    windowId: z.number().int().nonnegative(),
  }),
]);

/**
 * A row of the companion's picker, pressed. The two target shapes plus a tab,
 * which main resolves to a window before anything downstream sees it.
 */
export const companionCapturePickSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("display"),
    displayId: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("pointerDisplay"),
  }),
  z.object({
    kind: z.literal("window"),
    windowId: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("tab"),
    chromeWindowId: z.number().int().nonnegative(),
    tabIndex: z.number().int().positive(),
  }),
]);

/**
 * A drawing made over the shared surface, as the frame's window sends it.
 *
 * Bounded on every axis, because this is the one thing crossing the bridge
 * whose size is decided by how long a user holds the mouse down: the points
 * are fractions of the surface and so cannot fall outside `0`..`1`, and the
 * counts are capped where the sender caps them. Past the bounds the command
 * is refused rather than trimmed, since a stroke arriving longer than the
 * sender can produce is not a long drawing, it is a sender this main does not
 * recognise.
 */
export const companionAnnotationStrokeSchema = z.object({
  points: z
    .array(
      z.object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
      }),
    )
    .max(COMPANION_ANNOTATION_MAX_POINTS),
});

export const companionAnnotationPhaseSchema = z.enum(["drawing", "released"]);

export const companionAnnotationToolSchema = z.enum(COMPANION_ANNOTATION_TOOLS);

/**
 * The colour a drawing was made in, as `#rrggbb`.
 *
 * Narrower than {@link cssColorSchema} below, which exists for the title bar
 * and takes everything Chromium's parser does. This one ends up as a canvas
 * fill in the window that draws the marks onto a frame, so the one notation
 * the accent is ever expressed in is the only one worth accepting.
 */
export const companionAnnotationInkSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/);

/**
 * One thing the assistant is pointing at on the shared surface.
 *
 * Bounded per axis rather than as a rectangle inside the surface: a mark that
 * runs past an edge is a real answer (a control against the side of a
 * window), and the frame's window draws whatever part of it is on screen. A
 * corner outside `0`..`1` is a mark measured against some other surface, and
 * that is what the bounds refuse.
 */
const coachmarkCaption = z
  .string()
  .max(COMPANION_COACHMARK_CAPTION_MAX)
  .optional();

export const companionCoachmarkRegionSchema = z.object({
  kind: z.literal("region"),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
  caption: coachmarkCaption,
});

export const companionCoachmarkPointSchema = z.object({
  kind: z.literal("point"),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  caption: coachmarkCaption,
});

export const companionCoachmarkSchema = z.discriminatedUnion("kind", [
  companionCoachmarkRegionSchema,
  companionCoachmarkPointSchema,
]);

/** What the app's window tells main about the assistant the surface is for. */
export const companionContextSchema = z.object({
  assistantName: z.string(),
  // Defaulted rather than required so a renderer that predates the field still
  // publishes a valid context: the honest answer for a publisher that cannot
  // report a turn is that it is not reporting one.
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
  // Optional rather than defaulted, for the reason `watchRetro` is: every shape
  // it can hold names something the session is reading, and absence is the
  // only way to say it reads the whole screen.
  captureTarget: watchCaptureTargetSchema.optional(),
  // Defaulted for the reason `watching` is: a publisher that does not say
  // whether its sessions can be aimed is one whose sessions cannot.
  watchTargets: z.boolean().default(false),
  // Optional rather than defaulted, for the reason `captureTarget` is: every
  // shape it can hold names something being shared, and absence is the only
  // way to say nothing is.
  screenShare: watchCaptureTargetSchema.optional(),
  // Optional for the reason `screenShare` is, and it travels with it: an id
  // with no share names a conversation that owns nothing, and a share with no
  // id is a surface no conversation can claim.
  callConversationId: z.string().optional(),
  // Defaulted for the reason `watchTargets` is: a publisher that does not say
  // whether its call can be shown the screen is one whose call cannot.
  screenShareEnabled: z.boolean().default(false),
  // Optional rather than defaulted, for the reason `watchRetro` is: both values
  // claim a microphone is doing something, and absence is the only way to say
  // none is.
  dictating: z.enum(["listening", "transcribing"]).optional(),
  // Defaulted rather than optional: a publisher with nothing recognised yet is
  // reporting no words, and empty is the truthful reading of that. Bounded at
  // the boundary as well as at the publisher, since the surface draws one line
  // and the length is the only part of this a sender controls.
  dictationText: z.string().max(COMPANION_DICTATION_TAIL).catch("").default(""),
  // Optional rather than defaulted, for the reason `watchRetro` is: an offer
  // is a claim that something was said, and absence is the only way to say
  // nothing was. Bounded at the boundary as `dictationText` is, and narrowed
  // on the reason so a card cannot be handed an app name for a case that has
  // no app, or left without one for the case that needs it.
  dictationOffer: z
    .discriminatedUnion("reason", [
      z.object({
        reason: z.literal("claimed"),
        id: z.string().max(64),
        app: z.string().max(80),
        text: z.string().max(COMPANION_DICTATION_OFFER_MAX),
      }),
      z.object({
        reason: z.literal("no-text-field"),
        id: z.string().max(64),
        text: z.string().max(COMPANION_DICTATION_OFFER_MAX),
      }),
    ])
    .optional(),
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
