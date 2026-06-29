/**
 * Fetches empty-state (new-chat) greetings from the daemon's
 * `POST /v1/btw` side-chain.
 *
 * The daemon resolves an authored `## Greetings` line, a cached greeting, or a
 * fresh generation server-side (gated by `ui.emptyStateGreetingCacheTtlMs`) and
 * streams the result as Server-Sent Events: `btw_text_delta` carries each
 * chunk, `btw_complete` ends the stream, and `btw_error` reports a failure.
 *
 * `/btw` is not part of the generated daemon SDK, so we issue the POST through
 * the configured daemon `client` (which applies auth + local-mode forwarding
 * interceptors) with `parseAs: "stream"` and parse the SSE frames here.
 */

import { client } from "@/generated/daemon/client.gen";

/** Conversation key the daemon maps to the empty-state greeting call site. */
const GREETING_CONVERSATION_KEY = "greeting";

/**
 * Prompt for the empty-state greeting, kept in parity with the macOS Swift
 * client (`ChatGreetingState.generateGreeting()`) so both surfaces share one
 * voice.
 */
const GREETING_PROMPT =
  "Generate a short, casual greeting in your voice from you to your user. " +
  "This will be displayed when the user opens a new conversation (under 8 words). " +
  "Match your personality. Output ONLY the greeting text — no quotes, no formatting.";

/** Number of greeting variations requested in a single batch call. */
const GREETING_POOL_SIZE = 5;

/**
 * Prompt that requests multiple greeting variations in one LLM call.
 * The response is expected to be a JSON array of strings.
 */
const GREETING_POOL_PROMPT =
  `Generate ${GREETING_POOL_SIZE} short, casual greetings in your voice from you to your user. ` +
  "These will be displayed when the user opens a new conversation (under 8 words each). " +
  "Match your personality. Output ONLY a JSON array of strings — no markdown, no commentary.";

export interface StreamGreetingOptions {
  assistantId: string;
  /** Aborts the in-flight request (e.g. on conversation change / unmount). */
  signal?: AbortSignal;
  /** Invoked with the accumulated greeting text as each delta arrives. */
  onDelta?: (text: string) => void;
}

export interface FetchGreetingPoolOptions {
  assistantId: string;
  /** Aborts the in-flight request (e.g. on conversation change / unmount). */
  signal?: AbortSignal;
}

/**
 * Request a greeting and resolve with its full text. Rejects on a `btw_error`
 * event, a non-OK response, or a transport/abort failure — callers should fall
 * back to a default greeting.
 */
export async function streamEmptyStateGreeting({
  assistantId,
  signal,
  onDelta,
}: StreamGreetingOptions): Promise<string> {
  const { data, response } = await client.post({
    url: "/v1/assistants/{assistant_id}/btw",
    path: { assistant_id: assistantId },
    body: {
      conversationKey: GREETING_CONVERSATION_KEY,
      content: GREETING_PROMPT,
    },
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    parseAs: "stream",
    signal,
  });

  if (response && !response.ok) {
    throw new Error(`Greeting request failed with status ${response.status}`);
  }

  const stream = (data ?? response?.body) as
    | ReadableStream<Uint8Array>
    | null
    | undefined;
  if (!stream) {
    throw new Error("Greeting stream returned no body");
  }

  return readGreetingStream(stream, onDelta);
}

/**
 * Fetch multiple greeting variations in a single LLM call. The prompt asks the
 * model to return a JSON array of strings; on parse failure falls back to
 * treating the response as a single greeting.
 */
export async function fetchGreetingPool({
  assistantId,
  signal,
}: FetchGreetingPoolOptions): Promise<string[]> {
  const { data, response } = await client.post({
    url: "/v1/assistants/{assistant_id}/btw",
    path: { assistant_id: assistantId },
    body: {
      conversationKey: GREETING_CONVERSATION_KEY,
      content: GREETING_POOL_PROMPT,
    },
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    parseAs: "stream",
    signal,
  });

  if (response && !response.ok) {
    throw new Error(`Greeting pool request failed with status ${response.status}`);
  }

  const stream = (data ?? response?.body) as
    | ReadableStream<Uint8Array>
    | null
    | undefined;
  if (!stream) {
    throw new Error("Greeting pool stream returned no body");
  }

  const text = await readGreetingStream(stream);
  return parseGreetingPool(text);
}

/**
 * Extract an array of greeting strings from the LLM response. Handles markdown
 * code fences and falls back to the raw text as a single-element array.
 */
function parseGreetingPool(raw: string): string[] {
  const stripped = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    const parsed: unknown = JSON.parse(stripped);
    if (Array.isArray(parsed)) {
      const greetings = parsed
        .filter((item): item is string => typeof item === "string")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (greetings.length > 0) {
        return greetings;
      }
    }
  } catch {
    // Fall through to single-greeting fallback
  }
  const trimmed = raw.trim();
  if (trimmed.length > 0) {
    return [trimmed];
  }
  return [];
}

interface ParsedSseFrame {
  event: string;
  data: Record<string, unknown> | null;
}

/** Parse one `event: …\ndata: …` SSE frame. */
function parseSseFrame(frame: string): ParsedSseFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }
  if (dataLines.length === 0) return { event, data: null };
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return { event, data: null };
  }
}

async function readGreetingStream(
  stream: ReadableStream<Uint8Array>,
  onDelta?: (text: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        const parsed = parseSseFrame(frame);
        if (!parsed) continue;

        if (parsed.event === "btw_text_delta") {
          const delta =
            typeof parsed.data?.text === "string" ? parsed.data.text : "";
          if (delta) {
            text += delta;
            onDelta?.(text);
          }
        } else if (parsed.event === "btw_error") {
          const message =
            typeof parsed.data?.error === "string"
              ? parsed.data.error
              : "Greeting generation failed";
          throw new Error(message);
        } else if (parsed.event === "btw_complete") {
          return text;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return text;
}
