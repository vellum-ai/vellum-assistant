/**
 * Host shell tool - `host_bash`.
 *
 * Unlike the sandboxed `bash` tool, `host_bash` runs commands directly on the
 * host machine without the OS-level sandbox. Each invocation is approval-gated -
 * the guardian must explicitly approve it. It runs unsandboxed and could access
 * protected paths or credential material on disk.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";

import { supportsHostProxy } from "../../channels/types.js";
import { getConfig } from "../../config/loader.js";
import { HostBashProxy } from "../../daemon/host-bash-proxy.js";
import { RiskLevel } from "../../permissions/types.js";
import { wakeAgentForOpportunity } from "../../runtime/agent-wake.js";
import {
  assistantEventHub,
  broadcastMessage,
} from "../../runtime/assistant-event-hub.js";
import { isUntrustedShellActive } from "../../runtime/effective-capabilities.js";
import { redactSecrets } from "../../security/secret-scanner.js";
import { getLogger } from "../../util/logger.js";
import type { CompletedBackgroundTool } from "../background-tool-registry.js";
import {
  generateBackgroundToolId,
  isBackgroundToolLimitReached,
  MAX_BACKGROUND_TOOLS,
  recordCompletedBackgroundTool,
  registerBackgroundTool,
  removeBackgroundTool,
} from "../background-tool-registry.js";
import {
  formatShellOutput,
  MAX_OUTPUT_LENGTH,
} from "../shared/shell-output.js";
import { buildSanitizedEnv } from "../terminal/safe-env.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

const log = getLogger("host-shell-tool");

const HOST_BASH_PROXY_ENV_KEYS = [
  // Preserve per-instance routing so nested `assistant` CLI commands invoked
  // over host_bash proxy target the same daemon/socket as the origin turn.

  "VELLUM_WORKSPACE_DIR",
  // Keep legacy/diagnostic workspace + environment context aligned.
  "VELLUM_DATA_DIR",
  "VELLUM_ENVIRONMENT",
  // Preserve local control-plane routing when nested commands call APIs.
  "INTERNAL_GATEWAY_BASE_URL",
] as const;

function buildHostShellEnv(): Record<string, string> {
  const env = buildSanitizedEnv();
  // Ensure ~/.local/bin and ~/.bun/bin are in PATH so `vellum` and `bun` are
  // always reachable, even when the daemon is launched from a macOS app
  // bundle that inherits a minimal PATH.
  const home = homedir();
  const extraDirs = [`${home}/.local/bin`, `${home}/.bun/bin`];
  const currentPath = env.PATH ?? "";
  const missing = extraDirs.filter((d) => !currentPath.split(":").includes(d));
  if (missing.length > 0) {
    env.PATH = [...missing, currentPath].filter(Boolean).join(":");
  }
  return env;
}

function buildHostBashProxyEnv(
  conversationId: string,
  untrustedShell: boolean,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of HOST_BASH_PROXY_ENV_KEYS) {
    const value = process.env[key];
    if (value != null && value.length > 0) {
      env[key] = value;
    }
  }

  // Keep nested `assistant` CLI calls in host_bash aligned with the
  // originating conversation so browser IPC can resolve live proxy context.
  env.__CONVERSATION_ID = conversationId;
  // Inject VELLUM_UNTRUSTED_SHELL=1 so nested assistant CLI commands on the
  // proxied host can self-deny raw secret/token reveal flows.
  if (untrustedShell) {
    env.VELLUM_UNTRUSTED_SHELL = "1";
  }
  return env;
}

export const hostShellTool = {
  name: "host_bash",
  description:
    "LAST RESORT — Execute a shell command directly on the host machine. You MUST strongly prefer the regular `bash` tool for all commands. Only use `host_bash` when you are absolutely certain the command MUST run on the host machine and CANNOT run in the workspace (e.g., managing host-level system services, accessing host-only peripherals, or interacting with host paths outside the workspace). If in doubt, use `bash` instead. Approval-gated: each invocation must be explicitly approved. Do not use for commands that require injected credentials or secrets.",
  category: "host-terminal",
  executionTarget: "host",
  defaultRiskLevel: RiskLevel.Medium,

  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The host shell command to execute.",
      },
      activity: {
        type: "string",
        description:
          'Brief non-technical explanation of what this command does and why, shown to a non-technical user in the permission prompt. Avoid jargon and technical terms. Good: "to check if a required program is installed on your computer". Bad: "to check if gcloud CLI is installed". Good: "to download a helper program". Bad: "to run npm install".',
      },
      working_dir: {
        type: "string",
        description:
          "Optional absolute host working directory (defaults to user home)",
      },
      timeout_seconds: {
        type: "number",
        description:
          "Optional timeout in seconds. Uses configured default and max limits.",
      },
      background: {
        type: "boolean",
        description:
          "Run the command in the background on the host machine. The tool returns immediately with a background tool ID. When the process exits, its output is delivered to the conversation as a wake.",
      },
      target_client_id: {
        type: "string",
        description:
          "ID of the specific client to execute this command on. Required when multiple clients support host_bash; omit when only one client is connected. Obtain IDs from `assistant clients list --capability host_bash`.",
      },
    },
    required: ["command", "activity"],
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const command = input.command as string;
    if (!command || typeof command !== "string") {
      return {
        content: "Error: command is required and must be a string",
        isError: true,
      };
    }
    if (command.includes("\0")) {
      return { content: "Error: command contains null bytes", isError: true };
    }

    const rawWorkingDir = input.working_dir;
    if (rawWorkingDir != null && typeof rawWorkingDir !== "string") {
      return {
        content: "Error: working_dir must be a string when provided",
        isError: true,
      };
    }
    if (typeof rawWorkingDir === "string" && rawWorkingDir.includes("\0")) {
      return {
        content: "Error: working_dir contains null bytes",
        isError: true,
      };
    }
    if (typeof rawWorkingDir === "string" && !isAbsolute(rawWorkingDir)) {
      return {
        content: `Error: working_dir must be absolute for host command execution: ${rawWorkingDir}`,
        isError: true,
      };
    }
    const background = input.background === true;
    if (background && context.diskPressureCleanupModeActive === true) {
      return {
        content:
          "Error: background host shell commands are not available during disk pressure cleanup mode.",
        isError: true,
      };
    }

    const targetClientId =
      typeof input.target_client_id === "string" &&
      input.target_client_id !== ""
        ? input.target_client_id
        : undefined;

    const config = getConfig();
    const { shellDefaultTimeoutSec, shellMaxTimeoutSec } = config.timeouts;

    // Guard: non-host-proxy interfaces need an explicit target when multiple
    // capable clients are connected to avoid ambiguous untargeted broadcasts.
    const transportInterface = context.transportInterface;
    if (
      targetClientId == null &&
      transportInterface != null &&
      !supportsHostProxy(transportInterface) &&
      assistantEventHub.listClientsByCapability("host_bash").length > 1
    ) {
      return {
        content: `Error: multiple clients support host_bash. Specify which client to use with \`target_client_id\`. Run \`assistant clients list --capability host_bash\` to see client IDs and labels.`,
        isError: true,
      };
    }

    // Guard: non-host-proxy interfaces with no capable clients connected.
    if (
      targetClientId == null &&
      transportInterface != null &&
      !supportsHostProxy(transportInterface) &&
      !HostBashProxy.instance.isAvailable()
    ) {
      return {
        content:
          "Error: no client with host_bash capability is connected. Connect a macOS client to use host_bash from a non-desktop interface.",
        isError: true,
      };
    }

    // Guard: explicit targetClientId provided but proxy is unavailable (client
    // disconnected between tool-definition and tool-execution). Without this
    // guard both targetClientId != null guards above are bypassed, and the
    // code falls through to local daemon execution — silently running commands
    // inside the Docker container instead of on the intended host machine.
    if (targetClientId != null && !HostBashProxy.instance.isAvailable()) {
      return {
        content: `Error: target client "${targetClientId}" is no longer connected. The specified client may have disconnected since the tool was called. Run \`assistant clients list --capability host_bash\` to see currently connected clients.`,
        isError: true,
      };
    }

    // Proxy to connected client for execution on the user's machine
    // when a capable client is available (managed/cloud-hosted mode).
    if (HostBashProxy.instance.isAvailable()) {
      const rawSec =
        typeof input.timeout_seconds === "number"
          ? input.timeout_seconds
          : shellDefaultTimeoutSec;
      const normalizedTimeout = Math.max(
        1,
        Math.min(rawSec, shellMaxTimeoutSec),
      );
      // Forward instance-routing env vars so nested `assistant` CLI commands
      // executed on a proxied host machine can still resolve the correct
      // daemon IPC socket and workspace.
      const proxyEnv = buildHostBashProxyEnv(
        context.conversationId,
        isUntrustedShellActive({ trustClass: context.trustClass }),
      );

      if (background) {
        // Check the registry limit BEFORE starting the proxy request so we
        // never leak an untracked proxy when the registry is full.
        if (isBackgroundToolLimitReached()) {
          return {
            content: `Error: background tool limit reached (max ${MAX_BACKGROUND_TOOLS}). Cancel an existing background tool before starting a new one.`,
            isError: true,
          };
        }

        const bgId = generateBackgroundToolId();
        const abortController = new AbortController();
        const startedAt = Date.now();
        const proxyPromise = HostBashProxy.instance.request(
          {
            command,
            working_dir: rawWorkingDir as string | undefined,
            timeout_seconds: normalizedTimeout,
            env: proxyEnv,
            targetClientId,
          },
          context.conversationId,
          abortController.signal,
          context.sourceActorPrincipalId,
        );

        proxyPromise
          .then((result) => {
            // request() swallows the aborted rejection and resolves with an
            // "Aborted" result, so a tripped signal means the user cancelled.
            const status = abortController.signal.aborted
              ? "cancelled"
              : result.isError
                ? "failed"
                : "completed";
            // A cancelled command's proxy result carries SIGKILL/"failed"
            // framing; surface the cancellation instead (see shell.ts).
            const output =
              status === "cancelled"
                ? `Background host command cancelled (id=${bgId}).`
                : result.content;
            const completedAt = Date.now();
            const completion: CompletedBackgroundTool = {
              id: bgId,
              toolName: "host_bash",
              conversationId: context.conversationId,
              command,
              startedAt,
              status,
              exitCode: null,
              output,
              completedAt,
            };
            recordCompletedBackgroundTool(completion);
            broadcastMessage(
              {
                type: "background_tool_completed",
                id: bgId,
                conversationId: context.conversationId,
                status,
                output,
                completedAt,
              },
              context.conversationId,
            );
            const framing =
              status === "cancelled"
                ? `Background host command cancelled (id=${bgId}):`
                : result.isError
                  ? `Background host command failed (id=${bgId}):`
                  : `Background host command completed (id=${bgId}):`;
            void wakeAgentForOpportunity({
              conversationId: context.conversationId,
              hint: framing,
              source: "background-tool",
              persistTriggerAsEvent: true,
              backgroundToolCompletion: completion,
              untrustedOutput: {
                content: output || "(no output)",
                source: "tool_result",
                // Preserve formatShellOutput's recovery marker (see shell.ts).
                maxChars: MAX_OUTPUT_LENGTH * 2,
              },
            });
          })
          .catch((err) => {
            const status = abortController.signal.aborted
              ? "cancelled"
              : "failed";
            const output =
              status === "cancelled"
                ? `Background host command cancelled (id=${bgId}).`
                : err instanceof Error
                  ? err.message
                  : String(err);
            const completedAt = Date.now();
            const completion: CompletedBackgroundTool = {
              id: bgId,
              toolName: "host_bash",
              conversationId: context.conversationId,
              command,
              startedAt,
              status,
              exitCode: null,
              output,
              completedAt,
            };
            recordCompletedBackgroundTool(completion);
            broadcastMessage(
              {
                type: "background_tool_completed",
                id: bgId,
                conversationId: context.conversationId,
                status,
                output,
                completedAt,
              },
              context.conversationId,
            );
            void wakeAgentForOpportunity({
              conversationId: context.conversationId,
              hint:
                status === "cancelled"
                  ? `Background host command cancelled (id=${bgId}):`
                  : `Background host command failed (id=${bgId}): ${err instanceof Error ? err.message : String(err)}`,
              source: "background-tool",
              persistTriggerAsEvent: true,
              backgroundToolCompletion: completion,
            });
          })
          .finally(() => removeBackgroundTool(bgId));

        registerBackgroundTool({
          id: bgId,
          toolName: "host_bash",
          conversationId: context.conversationId,
          command,
          startedAt,
          cancel: (reason?: string) => abortController.abort(reason),
        });

        broadcastMessage(
          {
            type: "background_tool_started",
            id: bgId,
            toolName: "host_bash",
            conversationId: context.conversationId,
            command,
            startedAt,
          },
          context.conversationId,
        );

        return {
          content: JSON.stringify({ backgrounded: true, id: bgId }),
          isError: false,
        };
      }

      return HostBashProxy.instance.request(
        {
          command,
          working_dir: rawWorkingDir as string | undefined,
          timeout_seconds: normalizedTimeout,
          env: proxyEnv,
          targetClientId,
        },
        context.conversationId,
        context.signal,
        context.sourceActorPrincipalId,
      );
    }

    const workingDir =
      typeof rawWorkingDir === "string" ? rawWorkingDir : homedir();

    const requestedSec =
      typeof input.timeout_seconds === "number"
        ? input.timeout_seconds
        : shellDefaultTimeoutSec;
    const timeoutSec = Math.max(1, Math.min(requestedSec, shellMaxTimeoutSec));
    const timeoutMs = timeoutSec * 1000;

    log.info(
      {
        command: redactSecrets(command),
        cwd: workingDir,
        timeoutSec,
        conversationId: context.conversationId,
        background,
      },
      "Executing host shell command",
    );

    const hostEnv = buildHostShellEnv();
    // Match `bash` tool behavior so nested assistant CLI calls can bind to
    // the active conversation when running through host_bash.
    hostEnv.__CONVERSATION_ID = context.conversationId;
    // Inject VELLUM_UNTRUSTED_SHELL=1 so assistant CLI commands can self-deny
    // raw-token/secret reveal flows when invoked from an untrusted shell.
    if (isUntrustedShellActive({ trustClass: context.trustClass })) {
      hostEnv.VELLUM_UNTRUSTED_SHELL = "1";
    }

    if (background) {
      // Check the registry limit BEFORE spawning so we never leak an
      // untracked process when the registry is full.
      if (isBackgroundToolLimitReached()) {
        return {
          content: `Error: background tool limit reached (max ${MAX_BACKGROUND_TOOLS}). Cancel an existing background tool before starting a new one.`,
          isError: true,
        };
      }

      const bgId = generateBackgroundToolId();
      const startedAt = Date.now();

      const child = spawn("bash", ["-c", "--", command], {
        cwd: workingDir,
        env: hostEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      // Set when cancelled via the registry's cancel callback so the completion
      // event reports "cancelled" rather than "failed".
      let aborted = false;

      const killTree = () => {
        if (child.pid != null) {
          try {
            process.kill(-child.pid, "SIGKILL");
            return;
          } catch {
            // Process group may have already exited — fall through.
          }
        }
        try {
          child.kill("SIGKILL");
        } catch {
          // Child may have already exited.
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);

      child.stdout.on("data", (data: Buffer) => stdoutChunks.push(data));
      child.stderr.on("data", (data: Buffer) => stderrChunks.push(data));

      // Guard against double-wake: when spawn fails (e.g. invalid cwd),
      // Node emits both 'error' and 'close' for the same child process.
      // Only the first handler to fire should wake the agent.
      let completed = false;

      child.on("close", (code) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString();
        const stderr = Buffer.concat(stderrChunks).toString();
        const result = formatShellOutput(
          stdout,
          stderr,
          code,
          timedOut,
          timeoutSec,
        );
        // Cancel takes precedence over the SIGKILL-induced error result.
        const status = aborted
          ? "cancelled"
          : result.isError
            ? "failed"
            : "completed";
        // A cancelled command's SIGKILL output is framed as "failed";
        // surface the cancellation instead (see shell.ts).
        const output =
          status === "cancelled"
            ? `Background host command cancelled (id=${bgId}).`
            : result.content;
        const completedAt = Date.now();
        const completion: CompletedBackgroundTool = {
          id: bgId,
          toolName: "host_bash",
          conversationId: context.conversationId,
          command,
          startedAt,
          status,
          exitCode: code ?? null,
          output,
          completedAt,
        };
        recordCompletedBackgroundTool(completion);
        broadcastMessage(
          {
            type: "background_tool_completed",
            id: bgId,
            conversationId: context.conversationId,
            status,
            exitCode: code,
            output,
            completedAt,
          },
          context.conversationId,
        );
        const framing =
          status === "cancelled"
            ? `Background host command cancelled (id=${bgId}):`
            : result.isError
              ? `Background host command failed (id=${bgId}):`
              : `Background host command completed (id=${bgId}):`;
        void wakeAgentForOpportunity({
          conversationId: context.conversationId,
          hint: framing,
          source: "background-tool",
          persistTriggerAsEvent: true,
          backgroundToolCompletion: completion,
          untrustedOutput: {
            content: output || "(no output)",
            source: "tool_result",
            // Preserve formatShellOutput's recovery marker (see shell.ts).
            maxChars: MAX_OUTPUT_LENGTH * 2,
          },
        });
        removeBackgroundTool(bgId);
      });

      child.on("error", (err) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        const status = aborted ? "cancelled" : "failed";
        const output =
          status === "cancelled"
            ? `Background host command cancelled (id=${bgId}).`
            : err.message;
        const completedAt = Date.now();
        const completion: CompletedBackgroundTool = {
          id: bgId,
          toolName: "host_bash",
          conversationId: context.conversationId,
          command,
          startedAt,
          status,
          exitCode: null,
          output,
          completedAt,
        };
        recordCompletedBackgroundTool(completion);
        broadcastMessage(
          {
            type: "background_tool_completed",
            id: bgId,
            conversationId: context.conversationId,
            status,
            output,
            completedAt,
          },
          context.conversationId,
        );
        void wakeAgentForOpportunity({
          conversationId: context.conversationId,
          hint:
            status === "cancelled"
              ? `Background host command cancelled (id=${bgId}):`
              : `Background host command failed (id=${bgId}): ${err.message}`,
          source: "background-tool",
          persistTriggerAsEvent: true,
          backgroundToolCompletion: completion,
        });
        removeBackgroundTool(bgId);
      });

      registerBackgroundTool({
        id: bgId,
        toolName: "host_bash",
        conversationId: context.conversationId,
        command,
        startedAt,
        cancel: () => {
          aborted = true;
          killTree();
        },
      });

      broadcastMessage(
        {
          type: "background_tool_started",
          id: bgId,
          toolName: "host_bash",
          conversationId: context.conversationId,
          command,
          startedAt,
        },
        context.conversationId,
      );

      return {
        content: JSON.stringify({ backgrounded: true, id: bgId }),
        isError: false,
      };
    }

    return new Promise<ToolExecutionResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;

      const child = spawn("bash", ["-c", "--", command], {
        cwd: workingDir,
        env: hostEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      // Kill the entire process tree. Tries the process group first
      // (negative PID), then falls back to killing the direct child if the
      // PID is unavailable or the group kill fails.
      const killTree = () => {
        if (child.pid != null) {
          try {
            process.kill(-child.pid, "SIGKILL");
            return;
          } catch {
            // Process group may have already exited — fall through.
          }
        }
        try {
          child.kill("SIGKILL");
        } catch {
          // Child may have already exited.
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);

      // Cooperative cancellation via AbortSignal
      const onAbort = () => killTree();
      if (context.signal) {
        if (context.signal.aborted) {
          killTree();
        } else {
          context.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      child.stdout.on("data", (data: Buffer) => {
        stdoutChunks.push(data);
        context.onOutput?.(data.toString());
      });

      child.stderr.on("data", (data: Buffer) => {
        stderrChunks.push(data);
        context.onOutput?.(data.toString());
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", onAbort);

        const stdout = Buffer.concat(stdoutChunks).toString();
        const stderr = Buffer.concat(stderrChunks).toString();
        const result = formatShellOutput(
          stdout,
          stderr,
          code,
          timedOut,
          timeoutSec,
        );

        resolve({
          content: result.content,
          isError: result.isError,
          status: result.status,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", onAbort);
        let hint = "";
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          hint = !existsSync(workingDir)
            ? `. The working directory does not exist: ${workingDir}`
            : ". The command was not found - check that it is installed and in PATH.";
        }
        resolve({
          content: `Error spawning command: ${err.message}${hint}`,
          isError: true,
        });
      });
    });
  },
} satisfies ToolDefinition;
