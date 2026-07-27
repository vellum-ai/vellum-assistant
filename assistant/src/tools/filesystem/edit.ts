import { z } from "zod";

import { RiskLevel } from "../../permissions/types.js";
import { FileSystemOps } from "../shared/filesystem/file-ops-service.js";
import { formatEditDiff } from "../shared/filesystem/format-diff.js";
import { sandboxPolicyWithHostFallback } from "../shared/filesystem/path-policy.js";
import {
  invalidToolInputResult,
  toToolInputSchema,
} from "../shared/zod-tool-schema.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

/**
 * Model-input schema, the single source for both runtime validation (via
 * `TOOL_INPUT_SCHEMAS`) and the advertised `input_schema` below. `replace_all`
 * catches to `undefined` because the tool has always treated anything but a
 * literal `true` as "single match" — a malformed value degrades the same way
 * instead of failing the call.
 */
export const fileEditInputSchema = z.looseObject({
  path: z
    .string()
    .min(1)
    .describe(
      "The path to the file to edit (absolute or relative to working directory)",
    ),
  old_string: z
    .string()
    .min(1, { message: "old_string must not be empty" })
    .describe("The exact text to find in the file"),
  new_string: z.string().describe("The replacement text"),
  replace_all: z
    .boolean()
    .describe(
      "Replace all occurrences of old_string instead of requiring a unique match (default: false)",
    )
    .optional()
    .catch(undefined),
  activity: z
    .string()
    .describe(
      "Brief non-technical explanation of what you are doing and why, shown as a status update.",
    )
    .optional()
    .catch(undefined),
});

export const fileEditTool = {
  name: "file_edit",
  description:
    "Replace an exact string in a file on your own machine with a new string. Use this for surgical edits instead of rewriting entire files. Use host_file_edit for files on your guardian's device instead.",
  category: "filesystem",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,

  input_schema: toToolInputSchema(fileEditInputSchema, {
    advertiseRequired: ["activity"],
  }),

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const parsed = fileEditInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidToolInputResult("file_edit", parsed.error);
    }
    const {
      path: rawPath,
      old_string: oldString,
      new_string: newString,
    } = parsed.data;

    if (oldString === newString) {
      return {
        content: "Error: old_string and new_string must be different",
        isError: true,
      };
    }

    const replaceAll = parsed.data.replace_all === true;

    const ops = new FileSystemOps((path, opts) =>
      sandboxPolicyWithHostFallback(path, context.workingDir, opts),
    );

    const result = ops.editFileSafe({
      path: rawPath,
      oldString,
      newString,
      replaceAll,
    });

    if (!result.ok) {
      const { error } = result;
      switch (error.code) {
        case "MATCH_NOT_FOUND":
          return {
            content: `Error: old_string not found in ${error.path}`,
            isError: true,
          };
        case "MATCH_AMBIGUOUS":
          return {
            content: `Error: old_string appears multiple times in ${error.path}. Provide more surrounding context to make it unique, or set replace_all to true.`,
            isError: true,
          };
        case "IO_ERROR":
          return {
            content: `Error editing file: ${error.message}`,
            isError: true,
          };
        default: {
          const hint =
            error.code === "PATH_OUT_OF_BOUNDS"
              ? ". To edit files outside the workspace, use the host_file_edit tool instead."
              : "";
          return { content: `Error: ${error.message}${hint}`, isError: true };
        }
      }
    }

    const {
      filePath,
      matchCount,
      oldContent,
      newContent,
      matchMethod,
      similarity,
      actualOld,
      actualNew,
    } = result.value;

    const diffText = formatEditDiff(actualOld, actualNew);

    if (replaceAll) {
      return {
        content: `Successfully replaced ${matchCount} occurrence${
          matchCount > 1 ? "s" : ""
        } in ${filePath}\n${diffText}`,
        isError: false,
        diff: { filePath, oldContent, newContent, isNewFile: false },
      };
    }

    const methodNote =
      matchMethod === "exact"
        ? ""
        : matchMethod === "whitespace"
          ? " (matched with whitespace normalization)"
          : ` (fuzzy matched, ${Math.round(similarity * 100)}% similar)`;
    return {
      content: `Successfully edited ${filePath}${methodNote}\n${diffText}`,
      isError: false,
      diff: { filePath, oldContent, newContent, isNewFile: false },
    };
  },
} satisfies ToolDefinition;
