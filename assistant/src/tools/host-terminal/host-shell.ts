/**
 * Host shell tool - `host_bash`.
 *
 * Unlike the sandboxed `bash` tool, `host_bash` runs commands directly on the
 * host machine without the OS-level sandbox. Under CES shell lockdown for
 * untrusted actors, `host_bash` remains available as a user-approved escape
 * hatch - the guardian must explicitly approve each invocation. It is NOT part
 * of the strong CES secrecy guarantee because it runs unsandboxed and could
 * access protected paths or credential material on disk.
 *
 * To mitigate risk, when CES shell lockdown is active for untrusted sessions:
 * - Persistent approvals are disabled (every invocation requires fresh approval).
 * - The VELLUM_UNTRUSTED_SHELL=1 env flag is set so CLI commands self-deny
 *   raw-token/secret reveal flows.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import { isCesShellLockdownEnabled } from "../../credential-execution/feature-gates.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { isUntrustedTrustClass } from "../../runtime/actor-trust-resolver.js";
import { redactSecrets } from "../../security/secret-scanner.js";
import { getLogger } from "../../util/logger.js";
import { rewriteForRtk } from "../shared/rtk-rewrite.js";
import { formatShellOutput } from "../shared/shell-output.js";
import { buildSanitizedEnv } from "../terminal/safe-env.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

const log = getLogger("host-shell-tool");

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

class HostShellTool implements Tool {
  name = "host_bash";
  description =
    "LAST RESORT — Execute a shell command directly on the user's host machine. You MUST strongly prefer the regular `bash` tool for all commands. Only use `host_bash` when you are absolutely certain the command MUST run on the user's host machine and CANNOT run in the workspace (e.g., managing host-level system services, accessing host-only peripherals, or interacting with host paths outside the workspace). If in doubt, use `bash` instead. Approval-gated: your user must allow each invocation. Do not use for commands that require injected credentials or secrets.";
  category = "host-terminal";
  // host_bash is a weaker-tier escape hatch under CES lockdown. It remains
  // Medium risk by default but persistent approvals are disabled for
  // untrusted sessions (see execute()).
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
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
        },
        required: ["command", "activity"],
      },
    };
  }

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
    const config = getConfig();
    const { shellDefaultTimeoutSec, shellMaxTimeoutSec } = config.timeouts;

    // CES shell lockdown: host_bash is the weaker-tier escape hatch. When
    // lockdown is active for untrusted actors, persistent approvals are
    // disabled (every invocation requires fresh guardian approval) and the
    // VELLUM_UNTRUSTED_SHELL flag is injected to self-deny raw-secret CLI
    // commands. This does NOT provide the strong CES secrecy guarantee -
    // the subprocess runs unsandboxed and could access protected paths.
    //
    // NOTE: forcePromptSideEffects is set in executor.ts BEFORE the
    // permission check runs, not here. Setting it here would be too late
    // because execute() is called after permissions have already been evaluated.
    const hostLockdownActive =
      isCesShellLockdownEnabled(config) &&
      isUntrustedTrustClass(context.trustClass);

    // Proxy to connected client for execution on the user's machine
    // when a capable client is available (managed/cloud-hosted mode).
    if (context.hostBashProxy?.isAvailable()) {
      const rawSec =
        typeof input.timeout_seconds === "number"
          ? input.timeout_seconds
          : shellDefaultTimeoutSec;
      const normalizedTimeout = Math.max(
        1,
        Math.min(rawSec, shellMaxTimeoutSec),
      );
      // Propagate VELLUM_UNTRUSTED_SHELL to the proxied client so CLI
      // commands self-deny raw-secret flows even when executed remotely.
      const proxyEnv: Record<string, string> | undefined = hostLockdownActive
        ? { VELLUM_UNTRUSTED_SHELL: "1" }
        : undefined;
      return context.hostBashProxy.request(
        {
          command,
          working_dir: rawWorkingDir as string | undefined,
          timeout_seconds: normalizedTimeout,
          env: proxyEnv,
        },
        context.conversationId,
        context.signal,
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
        hostLockdownActive,
      },
      "Executing host shell command",
    );

    return new Promise<ToolExecutionResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;

      const hostEnv = buildHostShellEnv();
      // Inject VELLUM_UNTRUSTED_SHELL=1 so assistant CLI commands self-deny
      // raw-token/secret reveal flows when invoked from an untrusted shell.
      if (hostLockdownActive) {
        hostEnv.VELLUM_UNTRUSTED_SHELL = "1";
      }

      // When shell-output-compression is on, rewrite supported head
      // commands (git, pytest, tsc, …) to `rtk <cmd>` so rtk does the
      // compression before output reaches the context window. Probe
      // rtk against the PATH the subprocess will actually see — on
      // macOS app launch, `process.env.PATH` can be minimal while
      // `hostEnv.PATH` (from buildHostShellEnv) still resolves rtk.
      // Falls through to the original command when rtk isn't installed
      // or the head isn't rtk-eligible.
      const effectiveCommand = isAssistantFeatureFlagEnabled(
        "shell-output-compression",
        config,
      )
        ? rewriteForRtk(command, hostEnv.PATH ?? "")
        : command;

      const child = spawn("bash", ["-c", "--", effectiveCommand], {
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
  }
}

export const hostShellTool: Tool = new HostShellTool();
