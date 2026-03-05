import { spawn } from "node:child_process";

import { getConfig } from "../../config/loader.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { redactSecrets } from "../../security/secret-scanner.js";
import { getLogger } from "../../util/logger.js";
import { getDataDir } from "../../util/platform.js";
import { resolveCredentialRef } from "../credentials/resolve.js";
import {
  getOrStartSession,
  getSessionEnv,
} from "../network/script-proxy/index.js";
import { registerTool } from "../registry.js";
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
          reason: {
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
        required: ["command", "reason"],
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

    // Reject commands containing null bytes — they cause truncation at the
    // OS level while the parser sees the full string, enabling bypass.
    if (command.includes("\0")) {
      return { content: "Error: command contains null bytes", isError: true };
    }

    const networkMode: "off" | "proxied" =
      input.network_mode === "proxied" ? "proxied" : "off";

    const rawCredentialRefs: string[] = [];
    if (Array.isArray(input.credential_ids)) {
      for (const id of input.credential_ids) {
        if (typeof id === "string" && id.length > 0) {
          rawCredentialRefs.push(id);
        }
      }
    }

    // Resolve credential refs (UUID or service/field) to canonical UUIDs.
    // Fail fast if any ref is unresolvable — partial execution with missing
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

    const config = getConfig();
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

    // Resolve sandbox config early — needed both for proxy env and command wrapping.
    const sandboxConfig =
      context.sandboxOverride != null
        ? { ...config.sandbox, enabled: context.sandboxOverride }
        : config.sandbox;

    // Acquire a proxy session.
    //
    // - "proxied" mode: full proxy with credential injection.
    // - "off" mode: a lightweight "platform-only" proxy that allows traffic
    //   only to platform.vellum.ai (e.g. for `vellum skills list`).
    //
    // `getOrStartSession` serializes per-conversation so concurrent commands
    // share a single session instead of each creating one.
    // Sessions are NOT stopped here — the session manager's idle timer handles
    // cleanup after all commands finish (see resetIdleTimer / stopAllSessions).
    let proxyEnv: ProxyEnvVars | null = null;
    const platformOnly = networkMode === "off";

    try {
      const { session } = await getOrStartSession(
        context.conversationId,
        credentialIds,
        undefined,
        getDataDir(),
        context.proxyApprovalCallback,
        { platformOnly },
      );
      proxyEnv = getSessionEnv(session.id);
    } catch (err) {
      log.error({ err }, "Failed to start proxy session");
      // For platform-only sessions, failing to start the proxy is non-fatal —
      // the command simply won't be able to reach the platform API, which is
      // the same behavior as before this change.
      if (!platformOnly) {
        return {
          content: `Error: failed to start proxy session — ${
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

    const result = await new Promise<ToolExecutionResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;

      // When a proxy session is active the sandbox must allow network access
      // so the process can reach the local proxy on 127.0.0.1.
      const effectiveNetworkMode = proxyEnv != null ? "proxied" : networkMode;
      const wrapped = wrapCommand(command, context.workingDir, sandboxConfig, {
        networkMode: effectiveNetworkMode,
      });
      const child = spawn(wrapped.command, wrapped.args, {
        cwd: context.workingDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      // Cooperative cancellation via AbortSignal
      const onAbort = () => {
        child.kill("SIGKILL");
      };
      if (context.signal) {
        if (context.signal.aborted) {
          child.kill("SIGKILL");
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
              ? ". The command was not found — check that it is installed and in PATH."
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
