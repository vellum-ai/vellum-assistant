/**
 * `GET /v1/events` resolves a catalog-keyed `userMessage` for each
 * subscriber's `Accept-Language`, since the hub hands every subscriber the
 * same envelope.
 */

import { describe, expect, test } from "bun:test";

import { MESSAGE_KEYS, t } from "../i18n/index.js";
import { initializeDb } from "../persistence/db-init.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import { handleSubscribeAssistantEvents } from "../runtime/routes/events-routes.js";

await initializeDb();

const KEY = MESSAGE_KEYS.CONVERSATION_ERROR_PROVIDER_CONTENT_FILTERED;

async function nextMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ userMessage: string; userMessageKey?: string }> {
  const { value } = await reader.read();
  const frame = new TextDecoder().decode(value);
  const data = frame.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data!.slice("data: ".length)).message;
}

describe("GET /v1/events — per-subscriber locale", () => {
  test("two subscribers to one event each get their own language", async () => {
    // GIVEN a Spanish subscriber and one that sent no Accept-Language
    const ac = new AbortController();
    const hub = new AssistantEventHub();
    const subscribe = (headers?: Record<string, string>) => {
      const reader = handleSubscribeAssistantEvents(
        { headers, abortSignal: ac.signal },
        { hub },
      ).getReader();
      return reader;
    };
    const spanish = subscribe({ "accept-language": "es-MX,es;q=0.9" });
    const fallback = subscribe();
    await spanish.read(); // heartbeat
    await fallback.read(); // heartbeat

    // WHEN one keyed error is published
    await hub.publish(
      buildAssistantEvent({
        type: "conversation_error",
        conversationId: "conv-1",
        code: "PROVIDER_API",
        userMessage: t(KEY),
        userMessageKey: KEY,
        retryable: false,
      }),
    );
    const spanishMessage = await nextMessage(spanish);
    const fallbackMessage = await nextMessage(fallback);
    ac.abort();

    // THEN each reads it in their own language, and the key survives
    expect(spanishMessage.userMessage).toBe(t(KEY, "es"));
    expect(spanishMessage.userMessage).not.toBe(t(KEY));
    expect(spanishMessage.userMessageKey).toBe(KEY);
    expect(fallbackMessage.userMessage).toBe(t(KEY));
  });
});
