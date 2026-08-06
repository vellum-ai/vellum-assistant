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
 * `TOOL_INPUT_SCHEMAS`) and the advertised `input_schema` below. `offset` and
 * `limit` catch to `undefined` because the tool has always ignored non-numeric
 * values rather than failing the read.
 */
export const fileReadInputSchema = z.looseObject({
  path: z
    .string()
    .min(1)
    .describe(
      "The path to the file to read (absolute or relative to working directory)",
    ),
  offset: z
    .number()
    .describe("Line number to start reading from (1-indexed)")
    .optional()
    .catch(undefined),
  limit: z
    .number()
    .describe("Maximum number of lines to read (defaults to 2000)")
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
    "Read the contents of a file on your own machine. Text reads return the first 2000 lines unless you pass `limit`; when a read stops short the result says so, and `offset` pages on from there. For image files (JPEG, PNG, GIF, WebP), returns the image for visual analysis. For audio files (MP3, WAV, OGG, FLAC, AAC, M4A), returns the audio for listening. Use host_file_read for files on your guardian's device instead.",
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
    const { path: rawPath, offset, limit } = parsed.data;

    // For image files, delegate to the shared image reader.
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

    const ops = new FileSystemOps((path, opts) =>
      sandboxReadPolicy(path, context.workingDir, opts),
    );

    const result = await ops.readFileSafe({ path: rawPath, offset, limit });

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
