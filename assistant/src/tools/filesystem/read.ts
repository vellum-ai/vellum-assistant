import { extname } from "node:path";

import { z } from "zod";

import { RiskLevel } from "../../permissions/types.js";
import {
  AUDIO_EXTENSIONS,
  readAudioFile,
} from "../shared/filesystem/audio-read.js";
import { FileSystemOps } from "../shared/filesystem/file-ops-service.js";
import {
  IMAGE_EXTENSIONS,
  readImageFile,
} from "../shared/filesystem/image-read.js";
import { legacyReadArgsError } from "../shared/filesystem/legacy-read-args.js";
import { sandboxReadPolicy } from "../shared/filesystem/path-policy.js";
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
 * `TOOL_INPUT_SCHEMAS`) and the advertised `input_schema` below. `start_index`
 * and `max_chars` catch to `undefined` because the tool ignores non-numeric
 * values rather than failing the read.
 */
export const fileReadInputSchema = z.looseObject({
  path: z
    .string()
    .min(1)
    .describe(
      "The path to the file to read (absolute or relative to working directory)",
    ),
  start_index: z
    .number()
    .describe("Character to start reading from (0-indexed). Text files only.")
    .optional()
    .catch(undefined),
  max_chars: z
    .number()
    .describe(
      "Maximum number of characters to read. Defaults to 20000, which is also the ceiling. Text files only.",
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

export const fileReadTool = {
  name: "file_read",
  description:
    "Read the contents of a file on your own machine. Text reads return the first 20000 characters unless you pass `max_chars`; when a read stops short the result says so, and `start_index` pages on from there. To find where something is in a large file, code_search is cheaper than paging through it. For image files (JPEG, PNG, GIF, WebP), returns the image for visual analysis. For audio files (MP3, WAV, OGG, FLAC, AAC, M4A), returns the audio for listening. Use host_file_read for files on your guardian's device instead.",
  category: "filesystem",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,

  input_schema: toToolInputSchema(fileReadInputSchema, {
    advertiseRequired: ["activity"],
  }),

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const parsed = fileReadInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidToolInputResult("file_read", parsed.error);
    }
    const {
      path: rawPath,
      start_index: startIndex,
      max_chars: maxChars,
    } = parsed.data;

    // For image files, delegate to the shared image reader. Media reads carry
    // no window, so the legacy-argument guard below does not apply to them.
    const ext = extname(rawPath).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      const pathCheck = sandboxReadPolicy(rawPath, context.workingDir);
      if (!pathCheck.ok) {
        return {
          content: `Error: ${pathCheck.error}. To read files outside the workspace, use the host_file_read tool instead.`,
          isError: true,
        };
      }
      return readImageFile(pathCheck.resolved);
    }

    // For audio files, delegate to the shared audio reader.
    if (AUDIO_EXTENSIONS.has(ext)) {
      const pathCheck = sandboxReadPolicy(rawPath, context.workingDir);
      if (!pathCheck.ok) {
        return {
          content: `Error: ${pathCheck.error}. To read files outside the workspace, use the host_file_read tool instead.`,
          isError: true,
        };
      }
      return readAudioFile(pathCheck.resolved);
    }

    const legacyArgs = legacyReadArgsError("file_read", input);
    if (legacyArgs !== undefined) {
      return { content: legacyArgs, isError: true };
    }

    const ops = new FileSystemOps((path, opts) =>
      sandboxReadPolicy(path, context.workingDir, opts),
    );

    const result = await ops.readFileSafe({
      path: rawPath,
      startIndex,
      maxChars,
    });

    if (!result.ok) {
      const { error } = result;
      switch (error.code) {
        case "NOT_A_FILE":
          return {
            content: `Error: ${error.path} is a directory, not a file`,
            isError: true,
          };
        case "IO_ERROR":
          return {
            content: `Error reading file "${rawPath}": ${error.message}`,
            isError: true,
          };
        default: {
          const hint =
            error.code === "PATH_OUT_OF_BOUNDS"
              ? ". To read files outside the workspace, use the host_file_read tool instead."
              : "";
          return {
            content: `Error: ${error.message}${hint}`,
            isError: true,
          };
        }
      }
    }

    return { content: result.value.content, isError: false };
  },
} satisfies ToolDefinition;
