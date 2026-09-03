/**
 * Wire contract for the activation-checklist REST endpoints.
 *
 *   - `GET  /v1/activation/progress`             → `ActivationProgress`
 *   - `POST /v1/activation/tasks/:taskId/start`  → `ActivationProgress`
 *   - `POST /v1/activation/dismiss`              → `ActivationProgress`
 *
 * Holds the canonical progress shape shared by the on-disk store
 * (`activation/progress-store.ts`), the route handlers, the OpenAPI
 * generator, and every external client, so none of them can drift.
 *
 * Task ids and list ids are opaque to the daemon: the task catalog lives
 * client-side and only its identifiers are persisted here.
 */

import { z } from "zod";

/** Schema version of the on-disk progress file. */
export const ACTIVATION_PROGRESS_VERSION = 1;

/**
 * Character class every activation task id and list id must match.
 * Lowercase kebab-case, bounded so a hostile id cannot become a giant
 * JSON key on disk.
 */
export const ACTIVATION_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export const ActivationIdSchema = z
  .string()
  .regex(ACTIVATION_ID_PATTERN)
  .describe("Opaque lowercase-kebab identifier, 1-64 characters");

/** A file the assistant produced while working a task. */
export const ActivationArtifactSchema = z.object({
  workspacePath: z
    .string()
    .describe("Path of the produced file, as the assistant attached it"),
  displayName: z.string().describe("Human-readable file name for the card"),
});
export type ActivationArtifact = z.infer<typeof ActivationArtifactSchema>;

/** Per-task progress record. */
export const ActivationTaskProgressSchema = z.object({
  status: z
    .enum(["started", "done"])
    .describe("`started` while the linked conversation is working the task"),
  conversationId: z
    .string()
    .describe("Conversation the task was launched into"),
  startedAt: z.string().describe("ISO timestamp of the launch"),
  completedAt: z
    .string()
    .nullable()
    .describe("ISO timestamp of the completing turn, null while started"),
  stepCount: z
    .number()
    .int()
    .nullable()
    .describe("Tool calls observed in the linked conversation so far"),
  artifacts: z
    .array(ActivationArtifactSchema)
    .describe("Files the completing turn attached"),
});
export type ActivationTaskProgress = z.infer<
  typeof ActivationTaskProgressSchema
>;

/** Full activation progress resource. */
export const ActivationProgressSchema = z.object({
  version: z.literal(ACTIVATION_PROGRESS_VERSION).describe("Schema version"),
  listId: z
    .string()
    .nullable()
    .describe("Task list frozen on the first write, null before then"),
  modalDismissedAt: z
    .string()
    .nullable()
    .describe("ISO timestamp the welcome modal was dismissed"),
  allDoneShownAt: z
    .string()
    .nullable()
    .describe("ISO timestamp the celebration modal was dismissed"),
  tasks: z
    .record(z.string(), ActivationTaskProgressSchema)
    .describe("Progress keyed by task id"),
});
export type ActivationProgress = z.infer<typeof ActivationProgressSchema>;

export const ActivationTaskStartRequestSchema = z.object({
  conversationId: z
    .string()
    .min(1)
    .describe("Conversation the task prompt was sent to"),
  listId: ActivationIdSchema.optional().describe(
    "List the task came from, stored only while no list is frozen",
  ),
});
export type ActivationTaskStartRequest = z.infer<
  typeof ActivationTaskStartRequestSchema
>;

export const ActivationDismissKindSchema = z
  .enum(["modal", "all-done"])
  .describe("Which surface was dismissed");
export type ActivationDismissKind = z.infer<typeof ActivationDismissKindSchema>;

export const ActivationDismissRequestSchema = z.object({
  kind: ActivationDismissKindSchema,
  listId: ActivationIdSchema.optional().describe(
    "List the surface showed, stored only while no list is frozen",
  ),
});
export type ActivationDismissRequest = z.infer<
  typeof ActivationDismissRequestSchema
>;

/** Empty progress, returned before the store file exists. */
export function emptyActivationProgress(): ActivationProgress {
  return {
    version: ACTIVATION_PROGRESS_VERSION,
    listId: null,
    modalDismissedAt: null,
    allDoneShownAt: null,
    tasks: {},
  };
}
