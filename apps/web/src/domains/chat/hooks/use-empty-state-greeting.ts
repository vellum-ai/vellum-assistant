import { useEffect, useRef, useState } from "react";

import { SDK_BASE_OPTIONS } from "@/domains/chat/api/client";
import { DEFAULT_EMPTY_STATE_GREETING } from "@/domains/chat/utils/empty-state-constants";

const GREETING_PROMPT =
  "Generate a short, casual greeting in your voice from you to your user. " +
  "This will be displayed when the user opens a new conversation (under 8 words). " +
  "Match your personality. Output ONLY the greeting text — no quotes, no formatting.";

const MAX_GREETING_LENGTH = 80;

const FALLBACK_GREETINGS = [
  "What are we working on?",
  "I'm here whenever you need me.",
  "What's on your mind?",
  "Ready when you are.",
];

function pickFallback(): string {
  return FALLBACK_GREETINGS[
    Math.floor(Math.random() * FALLBACK_GREETINGS.length)
  ]!;
}

async function streamGreeting(
  assistantId: string,
  signal: AbortSignal,
  onDelta: (text: string) => void,
): Promise<string> {
  const baseUrl =
    (SDK_BASE_OPTIONS as Record<string, unknown>).baseUrl ?? "";
  const url = `${baseUrl}/v1/assistants/${encodeURIComponent(assistantId)}/btw`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationKey: "greeting",
      content: GREETING_PROMPT,
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`BTW request failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const payload = JSON.parse(line.slice(6)) as Record<string, unknown>;
          if (typeof payload.text === "string") {
            accumulated += payload.text;
            onDelta(payload.text);
          }
        } catch {
          // skip malformed JSON
        }
      }
    }
  }

  return accumulated;
}

export function useEmptyStateGreeting(
  assistantId: string | null | undefined,
): string {
  const [greeting, setGreeting] = useState("");
  const startedRef = useRef(false);

  useEffect(() => {
    if (!assistantId || startedRef.current) return;
    startedRef.current = true;

    const controller = new AbortController();

    streamGreeting(assistantId, controller.signal, (delta) => {
      setGreeting((prev) => prev + delta);
    })
      .then((final) => {
        const trimmed = final.trim();
        if (!trimmed || trimmed.length > MAX_GREETING_LENGTH) {
          setGreeting(pickFallback());
        } else {
          setGreeting(trimmed);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setGreeting(pickFallback());
        }
      });

    return () => controller.abort();
  }, [assistantId]);

  return greeting || DEFAULT_EMPTY_STATE_GREETING;
}
