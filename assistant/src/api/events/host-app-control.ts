/**
 * Host app-control proxy SSE events (`host_app_control_request` /
 * `host_app_control_cancel`).
 *
 * Server → client instructions that proxy app-control actions (start,
 * observe, press, combo, sequence, type, click, drag, stop) to the desktop
 * client, targeting a specific application by bundle ID or process name. The
 * client executes the action and POSTs the result back to
 * `/v1/host-app-control-result`. `host_app_control_cancel` withdraws an
 * in-flight request.
 *
 * Canonical wire-contract source. Daemon code imports the types
 * directly from this file; external consumers import via
 * `@vellumai/assistant-api`.
 */

import { z } from "zod";

const HostAppControlStartInputSchema = z.object({
  tool: z.literal("start"),
  /** Bundle ID (preferred) or process name. */
  app: z.string(),
  /** Optional command-line arguments to launch the app with. */
  args: z.array(z.string()).optional(),
});

const HostAppControlObserveInputSchema = z.object({
  tool: z.literal("observe"),
  app: z.string(),
  /** Milliseconds to wait before capturing the window (default ~200ms). */
  settle_ms: z.number().optional(),
});

const HostAppControlPressInputSchema = z.object({
  tool: z.literal("press"),
  app: z.string(),
  /** Single key identifier, e.g. "return", "a", "f12". */
  key: z.string(),
  /** Modifier list, e.g. ["cmd", "shift"]. */
  modifiers: z.array(z.string()).optional(),
  /** Hold duration in milliseconds. */
  duration_ms: z.number().optional(),
});

const HostAppControlComboInputSchema = z.object({
  tool: z.literal("combo"),
  app: z.string(),
  /** Sequence of keys pressed simultaneously, e.g. ["cmd", "shift", "4"]. */
  keys: z.array(z.string()),
  /** Hold duration in milliseconds. */
  duration_ms: z.number().optional(),
});

/** A single step inside a sequence: one key press with optional modifiers, hold duration, and post-press gap. */
export const HostAppControlSequenceStepSchema = z.object({
  /** Single key identifier, e.g. "right", "a", "return". */
  key: z.string(),
  /** Modifier list, e.g. ["cmd", "shift"]. Omit for no modifiers. */
  modifiers: z.array(z.string()).optional(),
  /** Hold duration for this key in milliseconds. */
  duration_ms: z.number().optional(),
  /** Pause after this step before starting the next, in milliseconds. */
  gap_ms: z.number().optional(),
});

export type HostAppControlSequenceStep = z.infer<
  typeof HostAppControlSequenceStepSchema
>;

const HostAppControlSequenceInputSchema = z.object({
  tool: z.literal("sequence"),
  app: z.string(),
  /** Ordered list of single-key presses to execute serially. */
  steps: z.array(HostAppControlSequenceStepSchema),
});

const HostAppControlTypeInputSchema = z.object({
  tool: z.literal("type"),
  app: z.string(),
  text: z.string(),
});

const HostAppControlClickInputSchema = z.object({
  tool: z.literal("click"),
  app: z.string(),
  x: z.number(),
  y: z.number(),
  button: z.enum(["left", "right", "middle"]).optional(),
  double: z.boolean().optional(),
});

const HostAppControlDragInputSchema = z.object({
  tool: z.literal("drag"),
  app: z.string(),
  from_x: z.number(),
  from_y: z.number(),
  to_x: z.number(),
  to_y: z.number(),
  button: z.enum(["left", "right", "middle"]).optional(),
});

const HostAppControlStopInputSchema = z.object({
  tool: z.literal("stop"),
  /** Optional — when omitted the proxy stops whichever app currently holds the session. */
  app: z.string().optional(),
  /** Free-form reason, surfaced for logging. */
  reason: z.string().optional(),
});

/** Inputs accepted by the nine app-control tool variants. */
export const HostAppControlInputSchema = z.discriminatedUnion("tool", [
  HostAppControlStartInputSchema,
  HostAppControlObserveInputSchema,
  HostAppControlPressInputSchema,
  HostAppControlComboInputSchema,
  HostAppControlSequenceInputSchema,
  HostAppControlTypeInputSchema,
  HostAppControlClickInputSchema,
  HostAppControlDragInputSchema,
  HostAppControlStopInputSchema,
]);

export type HostAppControlInput = z.infer<typeof HostAppControlInputSchema>;

export const HostAppControlRequestEventSchema = z.object({
  type: z.literal("host_app_control_request"),
  requestId: z.string(),
  conversationId: z.string(),
  /** "app_control_start", "app_control_observe", etc. */
  toolName: z.string(),
  input: HostAppControlInputSchema,
});

export type HostAppControlRequestEvent = z.infer<
  typeof HostAppControlRequestEventSchema
>;

export const HostAppControlCancelEventSchema = z.object({
  type: z.literal("host_app_control_cancel"),
  requestId: z.string(),
  conversationId: z.string(),
});

export type HostAppControlCancelEvent = z.infer<
  typeof HostAppControlCancelEventSchema
>;
