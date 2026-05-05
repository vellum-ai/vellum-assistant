/**
 * IPC route for executing shell commands through the assistant process.
 *
 * The CLI sends the command over the IPC socket and receives a single
 * response containing stdout, stderr, and the exit code.
 *
 * **Security**: Gated behind VELLUM_DEBUG=1. When debug mode is off (the
 * default), the handler returns an error immediately so the CLI surfaces a
 * clear rejection instead of hanging. The assistant must be restarted with
 * VELLUM_DEBUG=1 for this route to execute commands.
 */

import { spawn } from "node:child_process";

import { z } from "zod";

import { getIsContainerized } from "../../config/env-registry.js";
import { getWorkspaceDir } from "../../util/platform.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

function isDebugMode(): boolean {
  return (
    process.env.VELLUM_DEBUG === "1" || process.env.VELLUM_DEBUG === "true"
  );
}

interface DebugBashResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}

function handleDebugBash({ body }: RouteHandlerArgs): Promise<DebugBashResult> {
  if (getIsContainerized()) {
    return Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      error: "debug bash is not available in containerized environments",
    });
  }

  if (!isDebugMode()) {
    return Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      error:
        "Bash debug execution is disabled. The running assistant process must have been started with VELLUM_DEBUG=1 (setting it on the CLI command alone is not enough). Restart the assistant with: vellum sleep && VELLUM_DEBUG=1 vellum wake",
    });
  }

  const { command, timeoutMs } = body as {
    command?: string;
    timeoutMs?: number;
  };

  if (!command || typeof command !== "string") {
    return Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      error: "command is required",
    });
  }

  const effectiveTimeout =
    typeof timeoutMs === "number" && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_TIMEOUT_MS;

  return new Promise<DebugBashResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const finish = (result: DebugBashResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn("bash", ["-c", command], {
      cwd: getWorkspaceDir(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Process group may have already exited.
      }
    }, effectiveTimeout);

    child.stdout.on("data", (data: Buffer) => {
      stdoutChunks.push(data);
    });

    child.stderr.on("data", (data: Buffer) => {
      stderrChunks.push(data);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      finish({
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
        exitCode: code,
        timedOut,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      finish({
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: false,
        error: err.message,
      });
    });
  });
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "debug_bash",
    endpoint: "debug/bash",
    method: "POST",
    requireGuardian: false,
    summary: "Execute a shell command in the assistant process",
    description:
      "Developer debugging tool. Requires the assistant to be running with VELLUM_DEBUG=1.",
    tags: ["debug"],
    requestBody: z.object({
      command: z.string().describe("Shell command to execute via bash -c"),
      timeoutMs: z
        .number()
        .optional()
        .describe("Execution timeout in milliseconds (default: 30000)"),
    }),
    responseBody: z.object({
      stdout: z.string(),
      stderr: z.string(),
      exitCode: z.number().nullable(),
      timedOut: z.boolean(),
      error: z.string().optional(),
    }),
    handler: handleDebugBash,
  },
];
