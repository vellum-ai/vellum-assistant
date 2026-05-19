/**
 * Host camera proxy.
 *
 * Dispatches one request-scoped webcam snapshot to a connected desktop client,
 * summarizes the returned in-memory image through the configured provider, and
 * returns only the bounded text summary to the agent.
 */

import { runAction } from "../actions/run-action.js";
import {
  extractAllText,
  getConfiguredProvider,
} from "../providers/provider-send-message.js";
import type { Message } from "../providers/types.js";
import {
  assistantEventHub,
  broadcastMessage,
} from "../runtime/assistant-event-hub.js";
import {
  ambiguousSameUserError,
  enforceSameActorOrErrorResult,
  pickSameUserAutoResolve,
} from "../runtime/auth/same-actor.js";
import type { ToolExecutionResult } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import { HostProxyBase, HostProxyRequestError } from "./host-proxy-base.js";
import type { ActionLifecycleMessage } from "./message-types/actions.js";
import type {
  HostCameraInput,
  HostCameraResultPayload,
} from "./message-types/host-camera.js";

const log = getLogger("host-camera-proxy");
const MAX_SUMMARY_CHARS = 1_500;

export class HostCameraProxy extends HostProxyBase<
  HostCameraInput,
  HostCameraResultPayload
> {
  constructor() {
    super({
      capabilityName: "host_camera",
      requestEventName: "host_camera_request",
      cancelEventName: "host_camera_cancel",
      resultPendingKind: "host_camera",
      timeoutMs: 90_000,
      disposedMessage: "Host camera proxy disposed",
    });
  }

  async request(
    toolName: "describe_camera_once",
    input: HostCameraInput,
    conversationId: string,
    signal?: AbortSignal,
    sourceActorPrincipalId?: string,
  ): Promise<ToolExecutionResult> {
    if (signal?.aborted) {
      return { content: "Camera snapshot was aborted.", isError: true };
    }

    const resolvedTarget = this.resolveTargetClient(
      input.target_client_id,
      sourceActorPrincipalId,
    );
    if (resolvedTarget.error) return resolvedTarget.error;

    return runAction<ToolExecutionResult>({
      actionName: "host_camera.describe_once",
      conversationId,
      inputSummary: JSON.stringify({
        prompt: input.prompt ?? null,
        targetClientId: resolvedTarget.targetClientId ?? null,
      }),
      riskLevel: "Medium",
      onLifecycle: (event) => {
        const message: ActionLifecycleMessage = {
          type: "action_lifecycle",
          actionId: event.actionId,
          actionName: event.actionName,
          stage: event.stage,
          ts: event.ts,
          ...(event.message ? { message: event.message } : {}),
          conversationId,
        };
        broadcastMessage(message, conversationId);
      },
      execute: async () => {
        try {
          const payload = await this.dispatchRequest(
            toolName,
            input,
            conversationId,
            signal,
            undefined,
            resolvedTarget.targetClientId,
          );
          return await summarizeCameraSnapshot(payload, input.prompt, signal);
        } catch (err) {
          if (err instanceof HostProxyRequestError) {
            const content =
              err.reason === "timeout"
                ? "Camera snapshot timed out waiting for the desktop client."
                : err.reason === "aborted"
                  ? "Camera snapshot was aborted."
                  : "Camera snapshot was cancelled because the proxy was disposed.";
            return { content, isError: true };
          }
          log.warn({ err }, "Host camera proxy request failed");
          return {
            content: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }
      },
    });
  }

  private resolveTargetClient(
    targetClientId: string | undefined,
    sourceActorPrincipalId: string | undefined,
  ): { targetClientId?: string; error?: ToolExecutionResult } {
    if (targetClientId) {
      const target = assistantEventHub.getClientById(targetClientId);
      if (!target || !target.capabilities.includes("host_camera")) {
        return {
          error: {
            content: `Error: client "${targetClientId}" is not connected or does not support host_camera. Run \`assistant clients list --capability host_camera\` to see available clients.`,
            isError: true,
          },
        };
      }
      const rejection = enforceSameActorOrErrorResult({
        hub: assistantEventHub,
        sourceActorPrincipalId,
        targetClientId,
        op: "host_camera",
      });
      if (rejection) return { error: rejection };
      return { targetClientId };
    }

    const resolved = pickSameUserAutoResolve({
      hub: assistantEventHub,
      capability: "host_camera",
      sourceActorPrincipalId,
    });
    if (resolved.kind === "ambiguous") {
      return { error: ambiguousSameUserError("host_camera") };
    }
    return {
      targetClientId: resolved.kind === "match" ? resolved.clientId : undefined,
    };
  }
}

async function summarizeCameraSnapshot(
  payload: HostCameraResultPayload,
  prompt: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ToolExecutionResult> {
  if (payload.error) {
    return { content: payload.error, isError: true };
  }
  if (!payload.imageBase64) {
    return {
      content:
        "Camera snapshot failed: the desktop client did not return an image.",
      isError: true,
    };
  }

  const provider = await getConfiguredProvider("mainAgent");
  if (!provider) {
    return {
      content:
        "Camera snapshot failed: no configured LLM provider is available to summarize the image.",
      isError: true,
    };
  }

  const mediaType = payload.mediaType ?? "image/jpeg";
  const userPrompt =
    prompt?.trim() ||
    "Briefly describe what is visible in this single webcam snapshot.";
  const messages: Message[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            "Summarize this one webcam snapshot for the assistant. " +
            "Do not include identity guesses, sensitive inferences, or unrelated speculation. " +
            `User intent: ${userPrompt}`,
        },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: payload.imageBase64,
          },
        },
      ],
    },
  ];

  const response = await provider.sendMessage(
    messages,
    [],
    "You produce concise, privacy-aware descriptions of one-off webcam snapshots. Keep the answer under 150 words.",
    { signal },
  );
  const summary = extractAllText(response).trim();
  if (!summary) {
    return {
      content:
        "Camera snapshot was captured, but the summarizer returned no text.",
      isError: true,
    };
  }
  return {
    content:
      summary.length > MAX_SUMMARY_CHARS
        ? `${summary.slice(0, MAX_SUMMARY_CHARS).trimEnd()}...`
        : summary,
    isError: false,
  };
}
