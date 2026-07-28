import type { z } from "zod";

import { askQuestionInputSchema } from "./ask-question/ask-question-tool.js";
import { fileEditInputSchema } from "./filesystem/edit.js";
import { fileListInputSchema } from "./filesystem/list.js";
import { fileReadInputSchema } from "./filesystem/read.js";
import { fileWriteInputSchema } from "./filesystem/write.js";
import { hostFileEditInputSchema } from "./host-filesystem/edit.js";
import { hostFileReadInputSchema } from "./host-filesystem/read.js";
import { hostFileWriteInputSchema } from "./host-filesystem/write.js";
import { hostShellInputSchema } from "./host-terminal/host-shell.js";
import { formatToolInputError } from "./shared/zod-tool-schema.js";
import { notifyParentInputSchema } from "./subagent/notify-parent.js";
import { requestSystemPermissionInputSchema } from "./system/request-permission.js";
import { shellInputSchema } from "./terminal/shell.js";

/**
 * Per-tool Zod input schemas, keyed by tool name. Tool calls are a
 * discriminated payload — the tool name determines the shape of `input` —
 * but the model's JSON arrives untrusted, so the pre-execution gate
 * (`ToolApprovalHandler.checkPreExecutionGates`) parses it against this
 * registry (via {@link parseToolInput}) before any executor reads a field —
 * and, crucially, before any one-time grant is consumed or guardian
 * escalation starts, so a malformed call can never interrupt the guardian.
 * Each schema is also the source the tool derives its advertised
 * `input_schema` from (`toToolInputSchema` in `shared/zod-tool-schema.ts`),
 * so the model-facing contract and the runtime validation cannot drift.
 *
 * Covers built-in (`default`-owned) tools only — skill / plugin / MCP /
 * workspace tools own their schemas elsewhere, and the executor skips this
 * registry for them (a workspace override of a built-in name must not be
 * validated against the built-in's schema).
 *
 * Authoring rules, so validation never tightens behavior a tool already
 * tolerates:
 *
 * - Top-level schemas are `z.looseObject` — unknown keys (including the
 *   injected `activity` field, see `schema-transforms.ts`) pass through.
 * - A field the tool silently ignores when malformed gets
 *   `.optional().catch(undefined)` so a bad value degrades exactly as the
 *   tool always degraded, instead of failing the call.
 * - Fields the advertised schema requires only to guide the model (e.g.
 *   `activity`, which is status-only and never read by the tool) stay
 *   optional-with-`.catch(undefined)` here; the derivation marks them
 *   required via `advertiseRequired`.
 */
export const TOOL_INPUT_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  ask_question: askQuestionInputSchema,
  bash: shellInputSchema,
  file_edit: fileEditInputSchema,
  file_list: fileListInputSchema,
  file_read: fileReadInputSchema,
  file_write: fileWriteInputSchema,
  host_bash: hostShellInputSchema,
  host_file_edit: hostFileEditInputSchema,
  host_file_read: hostFileReadInputSchema,
  host_file_write: hostFileWriteInputSchema,
  notify_parent: notifyParentInputSchema,
  request_system_permission: requestSystemPermissionInputSchema,
};

/**
 * Validate model-supplied tool input against the registered schema for
 * `name`, returning the parsed value (with `.catch()` recoveries applied) or
 * a descriptive, model-correctable error message. A tool with no registered
 * schema passes through unchanged.
 */
export function parseToolInput(
  name: string,
  input: Record<string, unknown>,
):
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; message: string } {
  const schema = TOOL_INPUT_SCHEMAS[name];
  if (!schema) {
    return { ok: true, data: input };
  }
  const result = schema.safeParse(input);
  if (!result.success) {
    return { ok: false, message: formatToolInputError(name, result.error) };
  }
  // Every registry schema is an object schema, so the parsed value is a
  // plain record; `z.ZodType`'s output is just too wide to say so statically.
  return { ok: true, data: result.data as Record<string, unknown> };
}
