import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import { isCesShellLockdownEnabled } from "../../credential-execution/feature-gates.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { isUntrustedTrustClass } from "../../runtime/actor-trust-resolver.js";
import { redactSecrets } from "../../security/secret-scanner.js";
import { getLogger } from "../../util/logger.js";
import {
  getDataDir,
  getProtectedDir,
  getWorkspaceDir,
} from "../../util/platform.js";
import { resolveCredentialRef } from "../credentials/resolve.js";
import {
  getOrStartSession,
  getSessionEnv,
} from "../network/script-proxy/index.js";
import { registerTool } from "../registry.js";
import { rewriteForRtk } from "../shared/rtk-rewrite.js";
import { formatShellOutput } from "../shared/shell-output.js";
import type {
  ProxyEnvVars,
  Tool,
  ToolContext,
  ToolExecutionResult,
} from "../types.js";
import { buildSanitizedEnv } from "./safe-env.js";
import { wrapCommand } from "./sandbox.js";

/** Build a credential ref resolution trace for diagnostic logging. */
function buildCredentialRefTrace(
  rawRefs: string[],
  resolvedIds: string[],
  unresolvedRefs: string[],
) {
  return { rawRefs, resolvedIds, unresolvedRefs };
}

/**
 * Build the list of absolute paths that should be blocked from read access
 * inside the sandbox when CES shell lockdown is active.
 *
 * Blocked paths include:
 * - Gateway security directory (credential store secrets, CES data)
 * - ~/.vellum/workspace/data/db/ - database files that may contain credential metadata
 * - CES bootstrap socket directory (/run/ces-bootstrap/ or CES_BOOTSTRAP_SOCKET_DIR)
 * - CES managed-mode data root (CES_DATA_DIR, or /ces-data when CES_MANAGED_MODE is set)
 */
function buildCesProtectedPaths(): string[] {
  // Block both the legacy global protected dir and the current per-instance
  // protected dir so the sandbox read-block works in both single-instance
  // and multi-instance setups. In the default case (no BASE_DATA_DIR) the
  // two entries collapse via the Set dedupe.
  const protectedDirs = process.env.GATEWAY_SECURITY_DIR
    ? [process.env.GATEWAY_SECURITY_DIR]
    : Array.from(
        new Set([join(homedir(), ".vellum", "protected"), getProtectedDir()]),
      );
  const paths = [...protectedDirs, join(getWorkspaceDir(), "data", "db")];

  // CES bootstrap socket directory - block access to the Unix socket that
  // accepts RPC commands from the assistant process.
  const bootstrapSocketDir =
    process.env["CES_BOOTSTRAP_SOCKET_DIR"] || "/run/ces-bootstrap";
  paths.push(bootstrapSocketDir);

  // If a full socket path override is set (without the dir env var), block
  // its parent directory as well.
  if (
    !process.env["CES_BOOTSTRAP_SOCKET_DIR"] &&
    process.env["CES_BOOTSTRAP_SOCKET"]
  ) {
    paths.push(dirname(process.env["CES_BOOTSTRAP_SOCKET"]));
  }

  // CES managed-mode private data root - in managed deployments the CES
  // data lives outside the Vellum root, so it isn't covered by the
  // gateway security directory entry above.
  const cesDataDir = process.env["CES_DATA_DIR"];
  if (cesDataDir) {
    paths.push(cesDataDir);
  } else if (process.env["CES_MANAGED_MODE"]) {
    paths.push("/ces-data");
  }

  return paths;
}

const log = getLogger("shell-tool");

class ShellTool implements Tool {
  name = "bash";
  description = "Execute a shell command on the local machine";
  category = "terminal";
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
            description: "The shell command to execute",
          },
          activity: {
            type: "string",
            description:
              'Brief non-technical explanation of what this command does and why, shown to a non-technical user in the permission prompt. Avoid jargon and technical terms. Good: "to check if a required program is installed on your computer". Bad: "to check if gcloud CLI is installed". Good: "to download a helper program". Bad: "to run npm install".',
          },
          timeout_seconds: {
            type: "number",
            description:
              "Optional timeout in seconds. Defaults to the configured default (120s). Cannot exceed the configured maximum.",
          },
          network_mode: {
            type: "string",
            enum: ["off", "proxied"],
            description:
              'Network access mode for the command. "off" (default) blocks network access; "proxied" routes traffic through the credential proxy.',
          },
          credential_ids: {
            type: "array",
            items: { type: "string" },
            description:
              'Optional list of credential IDs to inject via the proxy when network_mode is "proxied".',
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

    // Reject commands containing null bytes - they cause truncation at the
    // OS level while the parser sees the full string, enabling bypass.
    if (command.includes("\0")) {
      return { content: "Error: command contains null bytes", isError: true };
    }

    const config = getConfig();
    const shellLockdownActive =
      isCesShellLockdownEnabled(config) &&
      isUntrustedTrustClass(context.trustClass);

    const networkMode: "off" | "proxied" =
      input.network_mode === "proxied" ? "proxied" : "off";

    // -----------------------------------------------------------------------
    // CES shell lockdown - reject proxied credential sessions for untrusted
    // actors when the lockdown flag is active. Proxied sessions grant the
    // subprocess access to credentials through the egress proxy, which
    // violates the secrecy guarantee.
    // -----------------------------------------------------------------------
    if (shellLockdownActive && networkMode === "proxied") {
      log.warn(
        { trustClass: context.trustClass },
        "CES shell lockdown: rejecting proxied credential session for untrusted actor",
      );
      return {
        content:
          "Error: proxied credential sessions are not available in untrusted shell mode. " +
          "Use the credential grant workflow to request access through a guardian.",
        isError: true,
      };
    }

    const rawCredentialRefs: string[] = [];
    if (Array.isArray(input.credential_ids)) {
      for (const id of input.credential_ids) {
        if (typeof id === "string" && id.length > 0) {
          rawCredentialRefs.push(id);
        }
      }
    }

    // -----------------------------------------------------------------------
    // CES shell lockdown - reject non-empty credential-ref mode for untrusted
    // actors. Even when network_mode is "off", passing credential_ids could
    // allow the model to probe stored credential metadata.
    // -----------------------------------------------------------------------
    if (shellLockdownActive && rawCredentialRefs.length > 0) {
      log.warn(
        { trustClass: context.trustClass, refCount: rawCredentialRefs.length },
        "CES shell lockdown: rejecting credential-ref mode for untrusted actor",
      );
      return {
        content:
          "Error: credential references are not available in untrusted shell mode. " +
          "Use the credential grant workflow to request access through a guardian.",
        isError: true,
      };
    }

    // Resolve credential refs (UUID or service/field) to canonical UUIDs.
    // Fail fast if any ref is unresolvable - partial execution with missing
    // credentials is worse than a clear error.
    const credentialIds: string[] = [];
    if (networkMode === "proxied" && rawCredentialRefs.length > 0) {
      const unresolvedRefs: string[] = [];
      const seenIds = new Set<string>();
      for (const ref of rawCredentialRefs) {
        const resolved = resolveCredentialRef(ref);
        if (!resolved) {
          unresolvedRefs.push(ref);
        } else if (!seenIds.has(resolved.credentialId)) {
          seenIds.add(resolved.credentialId);
          credentialIds.push(resolved.credentialId);
        }
      }
      if (unresolvedRefs.length > 0) {
        log.warn(
          {
            trace: buildCredentialRefTrace(
              rawCredentialRefs,
              credentialIds,
              unresolvedRefs,
            ),
          },
          "Credential ref resolution failed",
        );
        return {
          content: `Error: unknown credential reference(s): ${unresolvedRefs.join(
            ", ",
          )}. Use credential_store list to see available credentials.`,
          isError: true,
        };
      }
      log.debug(
        {
          trace: buildCredentialRefTrace(rawCredentialRefs, credentialIds, []),
        },
        "Credential refs resolved",
      );
    } else {
      credentialIds.push(...rawCredentialRefs);
    }

    const { shellDefaultTimeoutSec, shellMaxTimeoutSec } = config.timeouts;
    const requestedSec =
      typeof input.timeout_seconds === "number"
        ? input.timeout_seconds
        : shellDefaultTimeoutSec;
    const timeoutSec = Math.max(1, Math.min(requestedSec, shellMaxTimeoutSec));
    const timeoutMs = timeoutSec * 1000;

    log.info(
      {
        command: redactSecrets(command),
        cwd: context.workingDir,
        timeoutSec,
        networkMode,
        rawRefs: rawCredentialRefs,
        credentialIds,
      },
      "Executing shell command",
    );

    // The assistant runs exclusively in Docker or platform-managed
    // environments where the container provides isolation.
    const sandboxConfig = { enabled: false } as const;

    // Acquire proxy session if proxied mode is requested.
    // `getOrStartSession` serializes per-conversation so concurrent proxied
    // commands share a single session instead of each creating one.
    // Sessions are NOT stopped here - the session manager's idle timer handles
    // cleanup after all commands finish (see resetIdleTimer / stopAllSessions).
    let proxyEnv: ProxyEnvVars | null = null;

    if (networkMode === "proxied") {
      try {
        const { session } = await getOrStartSession(
          context.conversationId,
          credentialIds,
          undefined,
          getDataDir(),
          context.proxyApprovalCallback,
          undefined,
        );
        proxyEnv = getSessionEnv(session.id);
      } catch (err) {
        log.error({ err }, "Failed to start proxy session");
        return {
          content: `Error: failed to start proxy session - ${
            err instanceof Error ? err.message : String(err)
          }`,
          isError: true,
        };
      }
    }

    const env = buildSanitizedEnv();
    if (proxyEnv) {
      Object.assign(env, proxyEnv);
    }

    // Inject VELLUM_UNTRUSTED_SHELL=1 so assistant CLI commands can self-deny
    // raw-token/secret reveal flows when invoked from an untrusted shell.
    if (shellLockdownActive) {
      env.VELLUM_UNTRUSTED_SHELL = "1";
    }

    const result = await new Promise<ToolExecutionResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;

      // CES shell lockdown: build deny-read paths for protected credential
      // data, the protected dir, and data sub-dirs that contain secrets.
      const denyReadPaths: string[] | undefined = shellLockdownActive
        ? buildCesProtectedPaths()
        : undefined;

      // When shell-output-compression is on, rewrite supported head
      // commands (git, pytest, tsc, …) to `rtk <cmd>` so rtk does the
      // compression before output reaches the context window. Falls
      // through to the original command when rtk isn't installed or the
      // head isn't rtk-eligible.
      const effectiveCommand = isAssistantFeatureFlagEnabled(
        "shell-output-compression",
        config,
      )
        ? rewriteForRtk(command)
        : command;

      const wrapped = wrapCommand(
        effectiveCommand,
        context.workingDir,
        sandboxConfig,
        {
          networkMode,
          denyReadPaths,
        },
      );
      const child = spawn(wrapped.command, wrapped.args, {
        cwd: context.workingDir,
        env,
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
        const fmtResult = formatShellOutput(
          stdout,
          stderr,
          code,
          timedOut,
          timeoutSec,
        );

        resolve({
          content: fmtResult.content,
          isError: fmtResult.isError,
          status: fmtResult.status,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", onAbort);
        resolve({
          content: `Error spawning command: ${err.message}${
            (err as NodeJS.ErrnoException).code === "ENOENT"
              ? ". The command was not found - check that it is installed and in PATH."
              : ""
          }`,
          isError: true,
        });
      });
    });

    return result;
  }
}

export const shellTool: Tool = new ShellTool();
registerTool(shellTool);
