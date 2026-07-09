import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";

import { getConfig } from "../../config/loader.js";
import type { BackgroundToolCompleted } from "../../daemon/message-types/background-tools.js";
import { RiskLevel } from "../../permissions/types.js";
import { wakeAgentForOpportunity } from "../../runtime/agent-wake.js";
import { broadcastMessage } from "../../runtime/assistant-event-hub.js";
import { redactSecrets } from "../../security/secret-scanner.js";
import { getLogger } from "../../util/logger.js";
import { getDataDir } from "../../util/platform.js";
import type { CompletedBackgroundTool } from "../background-tool-registry.js";
import {
  generateBackgroundToolId,
  isBackgroundToolLimitReached,
  MAX_BACKGROUND_TOOLS,
  recordCompletedBackgroundTool,
  registerBackgroundTool,
  removeBackgroundTool,
} from "../background-tool-registry.js";
import { getCredentialMetadataById } from "../credentials/metadata-store.js";
import { resolveCredentialRef } from "../credentials/resolve.js";
import { isToolAllowed } from "../credentials/tool-policy.js";
import {
  getOrStartSession,
  getSessionEnv,
} from "../network/script-proxy/index.js";
import {
  formatShellOutput,
  MAX_OUTPUT_LENGTH,
} from "../shared/shell-output.js";
import type { ProxyEnvVars } from "../tool-types.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";
import { buildSanitizedEnv } from "./safe-env.js";

/** Build a credential ref resolution trace for diagnostic logging. */
function buildCredentialRefTrace(
  rawRefs: string[],
  resolvedIds: string[],
  unresolvedRefs: string[],
) {
  return { rawRefs, resolvedIds, unresolvedRefs };
}

const log = getLogger("shell-tool");

export const shellTool = {
  name: "bash",
  description: "Execute a shell command on the local machine",
  category: "terminal",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Medium,

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
      background: {
        type: "boolean",
        description:
          "Run the command in the background. The tool returns immediately with a background tool ID. When the process exits, its output is delivered to the conversation as a wake.",
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

    // Reject commands containing null bytes - they cause truncation at the
    // OS level while the parser sees the full string, enabling bypass.
    if (command.includes("\0")) {
      return { content: "Error: command contains null bytes", isError: true };
    }

    const background = input.background === true;
    if (background && context.diskPressureCleanupModeActive === true) {
      return {
        content:
          "Error: background shell commands are not available during disk pressure cleanup mode.",
        isError: true,
      };
    }

    const config = getConfig();

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
          )}. Use \`assistant credentials list\` to see available credentials.`,
          isError: true,
        };
      }
      log.debug(
        {
          trace: buildCredentialRefTrace(rawCredentialRefs, credentialIds, []),
        },
        "Credential refs resolved",
      );

      // -------------------------------------------------------------------
      // Tool policy enforcement — deny any credential that does not
      // explicitly allow "bash" in its allowedTools metadata. This check
      // runs after resolution/dedup and before proxy session creation so
      // that a denied credential never reaches getOrStartSession.
      // -------------------------------------------------------------------
      const deniedCredentials: { credentialId: string; reason: string }[] = [];
      for (const credId of credentialIds) {
        const meta = getCredentialMetadataById(credId);
        if (!meta) {
          // Should not happen — we just resolved these IDs — but fail-closed.
          deniedCredentials.push({
            credentialId: credId,
            reason: "metadata not found",
          });
          continue;
        }
        if (!isToolAllowed("bash", meta.allowedTools)) {
          const tools = meta.allowedTools ?? [];
          deniedCredentials.push({
            credentialId: credId,
            reason:
              tools.length === 0
                ? `credential ${meta.service}/${meta.field} has no allowed tools`
                : `credential ${meta.service}/${meta.field} allows [${tools.join(", ")}] but not bash`,
          });
        }
      }
      if (deniedCredentials.length > 0) {
        log.warn(
          { denied: deniedCredentials },
          "Credential tool policy denied for proxied bash",
        );
        const reasons = deniedCredentials
          .map((d) => `${d.credentialId}: ${d.reason}`)
          .join("; ");
        return {
          content: `Error: credential tool policy denied — ${reasons}. Each credential must include "bash" in its allowed tools to be used in a proxied shell session.`,
          isError: true,
        };
      }
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
    env.__CONVERSATION_ID = context.conversationId;
    // Surface the resolving model to assistant CLI commands so they can tailor
    // remediation guidance for weak open models (see isWeakOpenModel).
    if (context.attribution?.resolvedModel) {
      env.__RESOLVED_MODEL = context.attribution.resolvedModel;
    }
    if (proxyEnv) {
      Object.assign(env, proxyEnv);
    }

    const wrapped = { command: "bash", args: ["-c", "--", command] };

    // -----------------------------------------------------------------------
    // Background mode: spawn and return immediately. The process output is
    // delivered to the conversation as a wake when the process exits.
    // -----------------------------------------------------------------------
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
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      let aborted = false;
      const startedAt = Date.now();

      const child = spawn(wrapped.command, wrapped.args, {
        cwd: context.workingDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      const killTree = buildKillTree(child, {
        toolName: "bash",
        conversationId: context.conversationId,
        command,
        startedAt,
        invocationId: bgId,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        killTree("timeout");
      }, timeoutMs);

      child.stdout.on("data", (data: Buffer) => {
        stdoutChunks.push(data);
      });

      child.stderr.on("data", (data: Buffer) => {
        stderrChunks.push(data);
      });

      // Guard against double-wake: when spawn fails (e.g. invalid cwd),
      // Node emits both 'error' and 'close' for the same child process.
      // Only the first handler to fire should wake the agent.
      let completed = false;

      child.on("close", (code, signal) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        removeBackgroundTool(bgId);

        logShellExit({
          toolName: "bash",
          mode: "background",
          invocationId: bgId,
          conversationId: context.conversationId,
          command,
          startedAt,
          exitCode: code,
          signal,
          timedOut,
        });

        const stdout = Buffer.concat(stdoutChunks).toString();
        const stderr = Buffer.concat(stderrChunks).toString();
        const fmtResult = formatShellOutput(
          stdout,
          stderr,
          code,
          timedOut,
          timeoutSec,
        );

        const status: BackgroundToolCompleted["status"] = aborted
          ? "cancelled"
          : timedOut
            ? "failed"
            : code === 0
              ? "completed"
              : "failed";
        // A cancelled command exits with a null code, which formatShellOutput
        // frames as "failed"; surface the cancellation instead.
        const output =
          status === "cancelled"
            ? `Background command cancelled (id=${bgId}).`
            : fmtResult.content;
        const completedAt = Date.now();
        const completion: CompletedBackgroundTool = {
          id: bgId,
          toolName: "bash",
          conversationId: context.conversationId,
          command,
          startedAt,
          status,
          exitCode: code ?? null,
          output,
          completedAt,
        };

        // Wake AFTER the terminal status is known so a user-cancelled run wakes
        // the assistant with the cancellation — not the SIGKILL-framed "completed"
        // output — matching the recorded/broadcast status and the inline card.
        const framing =
          status === "cancelled"
            ? `Background command cancelled (id=${bgId}):`
            : `Background command completed (id=${bgId}, exit=${code ?? "unknown"}):`;
        void wakeAgentForOpportunity({
          conversationId: context.conversationId,
          hint: framing,
          source: "background-tool",
          persistTriggerAsEvent: true,
          backgroundToolCompletion: completion,
          untrustedOutput: {
            content: output,
            source: "tool_result",
            // Already bounded + recovery-marked by formatShellOutput; a larger
            // budget keeps wrapUntrustedContent from re-truncating the marker.
            maxChars: MAX_OUTPUT_LENGTH * 2,
          },
        });
        recordCompletedBackgroundTool(completion);
        broadcastMessage(
          {
            type: "background_tool_completed",
            id: bgId,
            conversationId: context.conversationId,
            status,
            exitCode: code ?? null,
            output,
            completedAt,
          },
          context.conversationId,
        );
      });

      child.on("error", (err) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        removeBackgroundTool(bgId);

        logShellExit({
          toolName: "bash",
          mode: "background",
          invocationId: bgId,
          conversationId: context.conversationId,
          command,
          startedAt,
          exitCode: null,
          signal: null,
          timedOut,
          spawnError: err.message,
        });

        const framing = `Background command failed (id=${bgId}): ${err.message}`;
        const completedAt = Date.now();
        const completion: CompletedBackgroundTool = {
          id: bgId,
          toolName: "bash",
          conversationId: context.conversationId,
          command,
          startedAt,
          status: "failed",
          exitCode: null,
          output: framing,
          completedAt,
        };
        void wakeAgentForOpportunity({
          conversationId: context.conversationId,
          hint: framing,
          source: "background-tool",
          persistTriggerAsEvent: true,
          backgroundToolCompletion: completion,
        });

        recordCompletedBackgroundTool(completion);
        broadcastMessage(
          {
            type: "background_tool_completed",
            id: bgId,
            conversationId: context.conversationId,
            status: "failed",
            exitCode: null,
            output: framing,
            completedAt,
          },
          context.conversationId,
        );
      });

      registerBackgroundTool({
        id: bgId,
        toolName: "bash",
        conversationId: context.conversationId,
        command,
        startedAt,
        cancel: () => {
          aborted = true;
          killTree("abort");
        },
      });

      broadcastMessage(
        {
          type: "background_tool_started",
          id: bgId,
          toolName: "bash",
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

    // -----------------------------------------------------------------------
    // Foreground mode: await the process and return its output.
    // -----------------------------------------------------------------------
    const result = await new Promise<ToolExecutionResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      const startedAt = Date.now();

      const child = spawn(wrapped.command, wrapped.args, {
        cwd: context.workingDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      const killTree = buildKillTree(child, {
        toolName: "bash",
        conversationId: context.conversationId,
        command,
        startedAt,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        killTree("timeout");
      }, timeoutMs);

      // Cooperative cancellation via AbortSignal
      const onAbort = () => killTree("abort");
      if (context.signal) {
        if (context.signal.aborted) {
          killTree("abort");
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

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", onAbort);

        logShellExit({
          toolName: "bash",
          mode: "foreground",
          conversationId: context.conversationId,
          command,
          startedAt,
          exitCode: code,
          signal,
          timedOut,
        });

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

        logShellExit({
          toolName: "bash",
          mode: "foreground",
          conversationId: context.conversationId,
          command,
          startedAt,
          exitCode: null,
          signal: null,
          timedOut,
          spawnError: err.message,
        });

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
  },
} satisfies ToolDefinition;

/**
 * Structured teardown log. Pairs with the `"Executing shell command"`
 * start log: every shell invocation now produces a start/exit pair so
 * orphan-leak post-mortems can correlate command + exitCode + signal +
 * timedOut + duration without spelunking through prose hints. The
 * `signal === "SIGKILL"` + `timedOut === true` combination is the
 * fingerprint left by the timeout watcher SIGKILLing the process group
 * — i.e. the moment that creates the orphans.
 */
function logShellExit(args: {
  toolName: string;
  mode: "foreground" | "background";
  conversationId: string;
  command: string;
  startedAt: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  invocationId?: string;
  spawnError?: string;
}): void {
  log.info(
    {
      toolName: args.toolName,
      mode: args.mode,
      invocationId: args.invocationId,
      conversationId: args.conversationId,
      command: redactSecrets(args.command),
      durationMs: Date.now() - args.startedAt,
      exitCode: args.exitCode,
      signal: args.signal,
      timedOut: args.timedOut,
      spawnError: args.spawnError,
    },
    "Shell command exited",
  );
}

/**
 * Kill the entire process tree of a child process. Tries the process group
 * first (negative PID), then falls back to killing the direct child if the
 * PID is unavailable or the group kill fails.
 *
 * Emits a structured `warn` log on every invocation: this is the
 * ground-truth event that creates orphaned subprocesses (the SIGKILL hits
 * the entire group, so the immediate bash child has no chance to reap its
 * grandchildren; under bun-as-PID-1 they accumulate as `<defunct>`).
 * `reason` lets the next zombie report point at a specific call site (the
 * timeout watcher in the foreground/background branches, or an abort).
 */
function buildKillTree(
  child: ChildProcess,
  context: {
    toolName: string;
    conversationId: string;
    command: string;
    startedAt: number;
    /** Stable id for this invocation — bgId for background tools. */
    invocationId?: string;
  },
): (reason: "timeout" | "abort" | "spawn_error") => void {
  return (reason) => {
    const groupPid = child.pid ?? null;
    log.warn(
      {
        toolName: context.toolName,
        conversationId: context.conversationId,
        command: redactSecrets(context.command),
        durationMs: Date.now() - context.startedAt,
        reason,
        groupPid,
        invocationId: context.invocationId,
      },
      "Shell process group SIGKILL'd — orphans expected to reparent to PID 1",
    );
    if (groupPid != null) {
      try {
        process.kill(-groupPid, "SIGKILL");
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
}
