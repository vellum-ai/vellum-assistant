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

/** Response of `POST /v1/acp/:id/steer`. Hand-maintained to match the daemon's action response shape. */
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
  // Resolve preconditions BEFORE the optimistic write so a missing active
  // assistant (e.g. after a lifecycle change) can't leave the run stuck
  // `cancelled` with no way back.
  const assistantId = activeAssistantId();
  const store = useAcpRunStore.getState();
  const prevStatus = store.byId[acpSessionId]?.status;
  store.cancelRun({ acpSessionId, completedAt: Date.now() });
  try {
    const { response } = await client.post({
      url: "/v1/assistants/{assistant_id}/acp/{id}/cancel" as KnownDaemonUrl,
      path: { assistant_id: assistantId, id: acpSessionId },
      body: {} as Record<string, unknown>,
    });
    if (!response?.ok) {
      throw new Error(`Failed to stop ACP run: ${response?.status}`);
    }
  } catch (err) {
    // The cancel didn't land — roll back the optimistic `cancelled` so the run
    // and its Stop control reappear (the subprocess may still be streaming).
    if (prevStatus !== undefined) {
      useAcpRunStore
        .getState()
        .restoreRunStatus({ acpSessionId, status: prevStatus });
    }
    throw err;
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
