/**
 * Platform terminal API client.
 *
 * Wraps the Django terminal session endpoints that proxy through vembda to
 * open K8s exec streams into managed assistant containers. Same transport
 * the web UI's xterm.js terminal uses.
 */

import { authHeaders, getPlatformUrl } from "./platform-client.js";

// ---------------------------------------------------------------------------
// Create / Close
// ---------------------------------------------------------------------------

export async function createTerminalSession(
  token: string,
  assistantId: string,
  cols: number,
  rows: number,
  platformUrl?: string,
): Promise<{ session_id: string }> {
  const baseUrl = platformUrl || getPlatformUrl();
  const response = await fetch(
    `${baseUrl}/v1/assistants/${assistantId}/terminal/sessions/`,
    {
      method: "POST",
      headers: await authHeaders(token, platformUrl),
      body: JSON.stringify({ cols, rows }),
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Failed to create terminal session (${response.status}): ${detail || response.statusText}`,
    );
  }
  return (await response.json()) as { session_id: string };
}

export async function closeTerminalSession(
  token: string,
  assistantId: string,
  sessionId: string,
  platformUrl?: string,
): Promise<void> {
  const baseUrl = platformUrl || getPlatformUrl();
  const response = await fetch(
    `${baseUrl}/v1/assistants/${assistantId}/terminal/sessions/${sessionId}/`,
    {
      method: "DELETE",
      headers: await authHeaders(token, platformUrl),
    },
  );
  // 404 = already closed, treat as success
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Failed to close terminal session (${response.status}): ${response.statusText}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Input / Resize
// ---------------------------------------------------------------------------

export async function sendTerminalInput(
  token: string,
  assistantId: string,
  sessionId: string,
  data: string,
  platformUrl?: string,
): Promise<void> {
  const baseUrl = platformUrl || getPlatformUrl();
  const response = await fetch(
    `${baseUrl}/v1/assistants/${assistantId}/terminal/sessions/${sessionId}/input/`,
    {
      method: "POST",
      headers: await authHeaders(token, platformUrl),
      body: JSON.stringify({ data }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to send terminal input (${response.status}): ${response.statusText}`,
    );
  }
}

export async function resizeTerminalSession(
  token: string,
  assistantId: string,
  sessionId: string,
  cols: number,
  rows: number,
  platformUrl?: string,
): Promise<void> {
  const baseUrl = platformUrl || getPlatformUrl();
  const response = await fetch(
    `${baseUrl}/v1/assistants/${assistantId}/terminal/sessions/${sessionId}/resize/`,
    {
      method: "POST",
      headers: await authHeaders(token, platformUrl),
      body: JSON.stringify({ cols, rows }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to resize terminal (${response.status}): ${response.statusText}`,
    );
  }
}

// ---------------------------------------------------------------------------
// SSE event stream
// ---------------------------------------------------------------------------

export interface TerminalOutputEvent {
  seq: number;
  /** Base64-encoded PTY output bytes. */
  data: string;
}

/**
 * Subscribe to the terminal output SSE stream. Yields parsed events as they
 * arrive. The generator completes when the stream ends or is aborted.
 */
export async function* subscribeTerminalEvents(
  token: string,
  assistantId: string,
  sessionId: string,
  platformUrl?: string,
  signal?: AbortSignal,
): AsyncGenerator<TerminalOutputEvent> {
  const baseUrl = platformUrl || getPlatformUrl();
  const response = await fetch(
    `${baseUrl}/v1/assistants/${assistantId}/terminal/sessions/${sessionId}/events/`,
    {
      headers: await authHeaders(token, platformUrl),
      signal,
    },
  );

  if (!response.ok || !response.body) {
    throw new Error(
      `SSE connection failed (${response.status}): ${response.statusText}`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed.startsWith("data: ")) {
          try {
            yield JSON.parse(trimmed.slice(6)) as TerminalOutputEvent;
          } catch {
            // Skip malformed SSE frames
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
