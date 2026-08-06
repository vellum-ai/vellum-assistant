import { extname } from "node:path";

import { z } from "zod";

import { supportsHostProxy } from "../../channels/types.js";
import { HostFileProxy } from "../../daemon/host-file-proxy.js";
import { RiskLevel } from "../../permissions/types.js";
import { assistantEventHub } from "../../runtime/assistant-event-hub.js";
import {
  AUDIO_EXTENSIONS,
  readAudioFile,
} from "../shared/filesystem/audio-read.js";
import {
  DEFAULT_READ_LINE_LIMIT,
  FileSystemOps,
} from "../shared/filesystem/file-ops-service.js";
import {
  IMAGE_EXTENSIONS,
  readImageFile,
} from "../shared/filesystem/image-read.js";
import { hostPolicy } from "../shared/filesystem/path-policy.js";
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
 * `TOOL_INPUT_SCHEMAS`) and the advertised `input_schema` below — mirrors
 * `filesystem/read.ts`. `offset`/`limit` catch to `undefined` so a
 * non-numeric value falls back to the default line window instead of failing
 * the call; `target_client_id` catches so a non-string (or empty) value means
 * "untargeted".
 */
export const hostFileReadInputSchema = z.looseObject({
  path: z
    .string()
    .min(1)
    .describe(
      "Absolute path on the guardian's device, which is a separate filesystem from your workspace, to read.",
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
  target_client_id: z
    .string()
    .describe(
      "ID of the specific client to execute this on. Required when multiple clients support host_file; omit when only one is connected. Obtain IDs from `assistant clients list --capability host_file`.",
    )
    .optional()
    .catch(undefined),
});

export const hostFileReadTool = {
  name: "host_file_read",
  description:
    "Read the contents of a file on your guardian's device, including images (JPEG, PNG, GIF, WebP) and audio (MP3, WAV, OGG, FLAC, AAC, M4A). Text reads return the first 2000 lines unless you pass `limit`; when a read stops short the result says so, and `offset` pages on from there. For files on your own machine, use file_read instead.",
  category: "host-filesystem",
  executionTarget: "host",
  defaultRiskLevel: RiskLevel.Medium,

  input_schema: toToolInputSchema(hostFileReadInputSchema),

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const parsed = hostFileReadInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidToolInputResult("host_file_read", parsed.error);
    }
    const { path: rawPath, offset } = parsed.data;
    // Resolve the default here rather than leaving it to the read, so the
    // proxied branch below is bounded by the same window as the local one. A
    // proxied read that sent no limit would stream a whole host file across
    // the bridge before anything could trim it.
    const limit = parsed.data.limit ?? DEFAULT_READ_LINE_LIMIT;

    const targetClientId =
      parsed.data.target_client_id !== ""
        ? parsed.data.target_client_id
        : undefined;

    const transportInterface = context.transportInterface;
    if (
      targetClientId == null &&
      transportInterface != null &&
      !supportsHostProxy(transportInterface) &&
      assistantEventHub.listClientsByCapability("host_file").length > 1
    ) {
      return {
        content: `Error: multiple clients support host_file. Specify which client to use with \`target_client_id\`. Run \`assistant clients list --capability host_file\` to see client IDs and labels.`,
        isError: true,
      };
    }

    // Guard: non-host-proxy interfaces with no capable clients connected.
    // Without this guard, the request would fall through to local
    // FileSystemOps below and read the daemon container's filesystem
    // instead of the user's host machine.
    if (
      targetClientId == null &&
      transportInterface != null &&
      !supportsHostProxy(transportInterface) &&
      !HostFileProxy.instance.isAvailable()
    ) {
      return {
        content:
          "Error: no client with host_file capability is connected. Connect a macOS client to use host_file from a non-desktop interface.",
        isError: true,
      };
    }

    // Guard: explicit targetClientId provided but proxy is unavailable.
    // Fires on non-host-proxy transports (web, ios) AND on legacy callers
    // without transport metadata, where falling through to local fs would
    // silently target the daemon container's filesystem instead of the
    // intended host client. Skips only when transport is explicitly
    // host-proxy-capable (macos), where local-fs fallback IS the intended
    // offline behavior — a stale target_client_id auto-filled from a prior
    // cross-client turn is silently ignored on those turns.
    // Note: this scoping deliberately differs from host_bash
    // (host-shell.ts:239-247), which rejects unconditionally for any
    // stale target_client_id regardless of transport.
    if (
      targetClientId != null &&
      !HostFileProxy.instance.isAvailable() &&
      (transportInterface == null || !supportsHostProxy(transportInterface))
    ) {
      return {
        content: `Error: target client "${targetClientId}" is no longer connected. The specified client may have disconnected since the tool was called. Run \`assistant clients list --capability host_file\` to see currently connected clients.`,
        isError: true,
      };
    }

    // Proxy to connected client for execution on the user's machine
    // when a capable client is available (managed/cloud-hosted mode),
    // including image reads that need the host filesystem view.
    if (HostFileProxy.instance.isAvailable()) {
      return HostFileProxy.instance.request(
        {
          operation: "read",
          path: rawPath,
          offset,
          limit,
          targetClientId,
        },
        context.conversationId,
        context.signal,
        targetClientId,
        context.sourceActorPrincipalId,
      );
    }

    const ext = extname(rawPath).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      const pathCheck = hostPolicy(rawPath);
      if (!pathCheck.ok) {
        return { content: `Error: ${pathCheck.error}`, isError: true };
      }
      return readImageFile(pathCheck.resolved);
    }

    if (AUDIO_EXTENSIONS.has(ext)) {
      const pathCheck = hostPolicy(rawPath);
      if (!pathCheck.ok) {
        return { content: `Error: ${pathCheck.error}`, isError: true };
      }
      return readAudioFile(pathCheck.resolved);
    }

    const ops = new FileSystemOps(hostPolicy);

    const result = await ops.readFileSafe({ path: rawPath, offset, limit });

    if (!result.ok) {
      const { error } = result;
      switch (error.code) {
        case "NOT_FOUND":
          return {
            content: `Error: File not found: ${error.path}`,
            isError: true,
          };
        case "NOT_A_FILE":
          return {
            content: `Error: ${error.path} is not a regular file`,
            isError: true,
          };
        case "IO_ERROR": {
          const msg = error.message;
          const hint = msg.includes("ENOENT")
            ? " (file does not exist)"
            : msg.includes("EACCES")
              ? " (permission denied)"
              : msg.includes("EISDIR")
                ? " (path is a directory, not a file)"
                : "";
          return {
            content: `Error reading file "${rawPath}"${hint}: ${msg}`,
            isError: true,
          };
        }
        default:
          return { content: `Error: ${error.message}`, isError: true };
      }
    }

    return { content: result.value.content, isError: false };
  },
} satisfies ToolDefinition;
