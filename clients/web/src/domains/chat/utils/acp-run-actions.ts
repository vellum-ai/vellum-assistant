/**
 * Imperative actions for ACP runs: stop (cancel) and steer.
 *
 * The daemon's `/v1/acp/*` routes are excluded from the generated web SDK
 * (see `scripts/transform-daemon-spec.ts`), so these call the daemon client
 * directly. The gateway proxies them via `/v1/assistants/{id}/acp/{id}/...`.
 */

import { client } from "@/generated/daemon/client.gen";
import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/** Response of `POST /v1/acp/:id/steer`. Mirrors the daemon's responseBody. */
export interface SteerAcpRunResponse {
  acpSessionId: string;
  steered: boolean;
  /** Session was resumed from persisted history before steering. */
  resumed?: boolean;
  /** Steer triggered an approval-gated resume that runs asynchronously. */
  approvalPending?: boolean;
}

// The generated client types `url` against known daemon paths; ACP routes are
// excluded from codegen, so cast to a sibling path to satisfy the type.
type KnownDaemonUrl = "/v1/assistants/{assistant_id}/config";

function activeAssistantId(): string {
  const id = useResolvedAssistantsStore.getState().activeAssistantId;
  if (!id) throw new Error("No active assistant");
  return id;
}

/**
 * Cancel an active ACP run. Optimistically marks the run cancelled so the live
 * card reflects the user's intent immediately and the daemon's prompt-rejection
 * `acp_session_error` (which it emits even on cancel) doesn't flash it to
 * `failed` before history rehydrates it as `cancelled`.
 */
export async function stopAcpRun(acpSessionId: string): Promise<void> {
  useAcpRunStore.getState().cancelRun({ acpSessionId, completedAt: Date.now() });
  const { response } = await client.post({
    url: "/v1/assistants/{assistant_id}/acp/{id}/cancel" as KnownDaemonUrl,
    path: { assistant_id: activeAssistantId(), id: acpSessionId },
    body: {} as Record<string, unknown>,
  });
  if (!response?.ok) {
    throw new Error(`Failed to stop ACP run: ${response?.status}`);
  }
}

/** Send a steering instruction to a running (or resumable) ACP run. */
export async function steerAcpRun(
  acpSessionId: string,
  instruction: string,
): Promise<SteerAcpRunResponse> {
  const { data, response } = await client.post({
    url: "/v1/assistants/{assistant_id}/acp/{id}/steer" as KnownDaemonUrl,
    path: { assistant_id: activeAssistantId(), id: acpSessionId },
    body: { instruction } as Record<string, unknown>,
  });
  if (!response?.ok) {
    throw new Error(`Failed to steer ACP run: ${response?.status}`);
  }
  return data as unknown as SteerAcpRunResponse;
}
