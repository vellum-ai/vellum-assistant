/**
 * Canonical zod schema for the raw model-loop {@link ContentBlock} union in
 * `providers/types.ts` — the shape PERSISTED into `messages.content` and
 * consumed by plugins/hooks.
 *
 * This is deliberately distinct from `ConversationContentBlockSchema`
 * (`api/responses/conversation-message.ts`), which is the cleaned wire/display
 * projection: that form merges tool results into their calls and drops
 * internal fields, so it cannot validate raw persisted content.
 *
 * Every variant uses `.passthrough()` rather than zod's default key-stripping:
 * persisted blocks carry internal riders (e.g. `_startedAt` /
 * `_previewStartedAt` timing stamps on thinking and tool_use blocks) that
 * must survive a parse→serialize round trip byte-for-byte.
 *
 * The export is typed `z.ZodType<ContentBlock>`, so the compiler enforces
 * that the schema's output stays assignable to the hand-written union —
 * drifting the schema away from `providers/types.ts` is a type error here.
 */

import { z } from "zod";

import type { ContentBlock } from "./types.js";

const base64MediaSourceSchema = z
  .object({
    type: z.literal("base64"),
    media_type: z.string(),
    data: z.string(),
    filename: z.string().optional(),
  })
  .passthrough();

const workspaceRefMediaSourceSchema = z
  .object({
    type: z.literal("workspace_ref"),
    media_type: z.string(),
    attachmentId: z.string(),
    sizeBytes: z.number(),
    filename: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  })
  .passthrough();

export const mediaSourceSchema = z.discriminatedUnion("type", [
  base64MediaSourceSchema,
  workspaceRefMediaSourceSchema,
]);

const textContentSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .passthrough();

const thinkingContentSchema = z
  .object({
    type: z.literal("thinking"),
    thinking: z.string(),
    signature: z.string(),
  })
  .passthrough();

const redactedThinkingContentSchema = z
  .object({
    type: z.literal("redacted_thinking"),
    data: z.string(),
  })
  .passthrough();

const imageContentSchema = z
  .object({
    type: z.literal("image"),
    source: mediaSourceSchema,
  })
  .passthrough();

const fileContentSchema = z
  .object({
    type: z.literal("file"),
    source: mediaSourceSchema,
    extracted_text: z.string().optional(),
    _attachmentId: z.string().optional(),
  })
  .passthrough();

const toolUseContentSchema = z
  .object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
    providerMetadata: z
      .object({
        gemini: z
          .object({ thoughtSignature: z.string().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const toolResultContentSchema = z
  .object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z.string(),
    is_error: z.boolean().optional(),
    contentBlocks: z.lazy(() => z.array(contentBlockSchema)).optional(),
  })
  .passthrough();

const serverToolUseContentSchema = z
  .object({
    type: z.literal("server_tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const webSearchToolResultContentSchema = z
  .object({
    type: z.literal("web_search_tool_result"),
    tool_use_id: z.string(),
    content: z.unknown(),
  })
  .passthrough();

export const contentBlockSchema: z.ZodType<ContentBlock> = z.discriminatedUnion(
  "type",
  [
    textContentSchema,
    thinkingContentSchema,
    redactedThinkingContentSchema,
    imageContentSchema,
    fileContentSchema,
    toolUseContentSchema,
    toolResultContentSchema,
    serverToolUseContentSchema,
    webSearchToolResultContentSchema,
  ],
);

export const contentBlockArraySchema = z.array(contentBlockSchema);
