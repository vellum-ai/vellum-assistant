import { z } from "zod";

export const ModeSessionModeSchema = z.enum([
  "computer_use",
  "browser",
  "live_vision",
  "ambient",
]);
export type ModeSessionMode = z.infer<typeof ModeSessionModeSchema>;

/** Whether a stamped row may start the user-visible span for this mode. */
export function modeSessionRowStartsDisplay(
  mode: ModeSessionMode,
  startsDisplayBoundary: boolean,
): boolean {
  return mode === "live_vision" || startsDisplayBoundary;
}

export const ModeSessionStatusSchema = z.enum([
  "active",
  "completed",
  "interrupted",
]);
export type ModeSessionStatus = z.infer<typeof ModeSessionStatusSchema>;

/** Immutable ownership stamped onto transcript message metadata. */
export const ModeSessionSchema = z.object({
  mode: ModeSessionModeSchema,
  id: z.string().min(1),
});
export type ModeSession = z.infer<typeof ModeSessionSchema>;

export function parseModeSession(value: unknown): ModeSession | undefined {
  const parsed = ModeSessionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Historic or caller-authored invalid stamps behave like an absent stamp. */
export const TolerantModeSessionSchema = z.preprocess(
  parseModeSession,
  ModeSessionSchema.optional(),
);

const MAX_DATE_MS = 8_640_000_000_000_000;

export const ModeSessionActivitySchema = z
  .object({
    firstAt: z.number().int().nonnegative().max(MAX_DATE_MS),
    lastAt: z.number().int().nonnegative().max(MAX_DATE_MS),
  })
  .refine((activity) => activity.lastAt >= activity.firstAt, {
    message: "Mode session activity cannot end before it starts",
    path: ["lastAt"],
  });
export type ModeSessionActivity = z.infer<typeof ModeSessionActivitySchema>;

const ModeSessionSummaryBaseSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  mode: ModeSessionModeSchema,
  sourceStartedAt: z.number().int().nonnegative(),
  firstIncludedAt: z.number().int().nonnegative().nullable(),
  firstIncludedMessageId: z.string().min(1).nullable(),
  lastActivityAt: z.number().int().nonnegative(),
  lastOwnedMessageId: z.string().min(1).nullable(),
  revision: z.number().int().positive(),
});

/** Durable lifecycle summary for one conversation-owned presentation run. */
export const ModeSessionSummarySchema = z
  .discriminatedUnion("status", [
    ModeSessionSummaryBaseSchema.extend({
      status: z.literal("active"),
      endedAt: z.null(),
      endReason: z.null(),
    }),
    ModeSessionSummaryBaseSchema.extend({
      status: z.literal("completed"),
      endedAt: z.number().int().nonnegative(),
      endReason: z.string().min(1),
    }),
    ModeSessionSummaryBaseSchema.extend({
      status: z.literal("interrupted"),
      endedAt: z.number().int().nonnegative().nullable(),
      endReason: z.string().min(1),
    }),
  ])
  .superRefine((summary, ctx) => {
    if (
      (summary.firstIncludedAt === null) !==
      (summary.firstIncludedMessageId === null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "First included time and message ID must be set together",
      });
    }
    if (summary.endedAt !== null && summary.endedAt < summary.lastActivityAt) {
      ctx.addIssue({
        code: "custom",
        message: "Mode session end cannot precede its last activity",
        path: ["endedAt"],
      });
    }
    if (summary.lastActivityAt < summary.sourceStartedAt) {
      ctx.addIssue({
        code: "custom",
        message: "Last activity cannot precede source start",
        path: ["lastActivityAt"],
      });
    }
    if (
      summary.firstIncludedAt !== null &&
      summary.firstIncludedAt > summary.lastActivityAt
    ) {
      ctx.addIssue({
        code: "custom",
        message: "First included time cannot follow last activity",
        path: ["firstIncludedAt"],
      });
    }
  });
export type ModeSessionSummary = z.infer<typeof ModeSessionSummarySchema>;

export const ModeSessionRuntimeStateSchema = z.enum(["waiting", "finishing"]);
export type ModeSessionRuntimeState = z.infer<
  typeof ModeSessionRuntimeStateSchema
>;

/** Durable lifecycle truth plus optional process-local presentation state. */
export const ModeSessionDescriptorSchema = z
  .object({
    summary: ModeSessionSummarySchema,
    runtimeState: ModeSessionRuntimeStateSchema.optional(),
  })
  .superRefine((descriptor, ctx) => {
    if (
      descriptor.runtimeState !== undefined &&
      descriptor.summary.status !== "active"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Only active mode sessions can expose runtime state",
        path: ["runtimeState"],
      });
    }
  });
export type ModeSessionDescriptor = z.infer<typeof ModeSessionDescriptorSchema>;
