/**
 * Thin API layer for the "Connect Claude" ACP OAuth flow.
 *
 * The daemon's `/v1/acp/*` routes are excluded from the generated web SDK
 * (see `scripts/transform-daemon-spec.ts`), so these call the daemon client
 * directly. The gateway proxies them via `/v1/assistants/{id}/acp/claude/auth/*`.
 */

import { client } from "@/generated/daemon/client.gen";
import { isElectron } from "@/runtime/is-electron";

// The generated client types `url` against known daemon paths; ACP routes are
// excluded from codegen, so cast to a sibling path to satisfy the type.
type KnownDaemonUrl = "/v1/assistants/{assistant_id}/config";

export type ConnectClaudeMode = "loopback" | "manual";
export type ConnectClaudeStatus = "pending" | "connected" | "error";

export interface ConnectClaudeStartResponse {
  /** `loopback` on a local host (daemon captures the redirect); `manual` in the
   *  cloud (the user pastes the `code#state` the redirect page renders). */
  mode: ConnectClaudeMode;
  authorize_url: string;
  state: string;
}

export interface ConnectClaudeStatusResponse {
  status: ConnectClaudeStatus;
  error?: string;
}

/** Begin the flow. Returns the authorize URL to open plus the flow `mode`. */
export async function startConnectClaude(
  assistantId: string,
): Promise<ConnectClaudeStartResponse> {
  // Loopback only works when the browser is co-located with the assistant (the
  // desktop shell, whose daemon is local). A plain browser may be talking to a
  // remote self-hosted assistant whose `localhost` callback it can't reach, so
  // request the manual paste path unless we're the desktop app.
  const { data, response } = await client.post({
    url: "/v1/assistants/{assistant_id}/acp/claude/auth/start" as KnownDaemonUrl,
    path: { assistant_id: assistantId },
    body: { preferManual: !isElectron() } as Record<string, unknown>,
  });
  if (!response?.ok) {
    throw new Error(`Failed to start Connect Claude flow: ${response?.status}`);
  }
  return data as unknown as ConnectClaudeStartResponse;
}

/** Poll a loopback flow until the daemon captures the token (or errors). */
export async function pollConnectClaudeStatus(
  assistantId: string,
  state: string,
): Promise<ConnectClaudeStatusResponse> {
  const { data, response } = await client.get({
    url: `/v1/assistants/{assistant_id}/acp/claude/auth/status/${encodeURIComponent(state)}` as KnownDaemonUrl,
    path: { assistant_id: assistantId },
  });
  if (!response?.ok) {
    throw new Error(
      `Failed to poll Connect Claude status: ${response?.status}`,
    );
  }
  return data as unknown as ConnectClaudeStatusResponse;
}

/**
 * Whether a Claude OAuth token is already stored for this workspace. Best-effort
 * self-heal signal for the inline Connect affordance; callers should treat a
 * thrown error (e.g. an older daemon without this route) as "unknown" and leave
 * the prompt in place rather than hiding it.
 */
export async function isClaudeConnected(assistantId: string): Promise<boolean> {
  const { data, response } = await client.get({
    url: "/v1/assistants/{assistant_id}/acp/claude/auth/connected" as KnownDaemonUrl,
    path: { assistant_id: assistantId },
  });
  if (!response?.ok) {
    throw new Error(`Failed to check Claude connection: ${response?.status}`);
  }
  return (data as unknown as { connected?: boolean }).connected === true;
}

/** Complete a manual/cloud flow with the pasted `code#state` (or a raw code). */
export async function exchangeConnectClaude(
  assistantId: string,
  code: string,
  state: string,
): Promise<void> {
  const { response } = await client.post({
    url: "/v1/assistants/{assistant_id}/acp/claude/auth/exchange" as KnownDaemonUrl,
    path: { assistant_id: assistantId },
    body: { code, state } as Record<string, unknown>,
  });
  if (!response?.ok) {
    throw new Error(
      `Failed to complete Connect Claude flow: ${response?.status}`,
    );
  }
}
