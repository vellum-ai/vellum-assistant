/**
 * React hook that streams a personalized empty-state greeting from the daemon.
 *
 * Mirrors the macOS app: each new empty conversation triggers a single
 * greeting generated via `POST /v1/btw` (`conversationKey: "greeting"`), which
 * streams in token-by-token. The daemon owns the prompt, voice, authored
 * `## Greetings` override, and a configurable cache TTL
 * (`ui.emptyStateGreetingCacheTtlMs`) — so whether a request hits the LLM or
 * replays a cached greeting is decided server-side. Falls back to
 * {@link DEFAULT_EMPTY_STATE_GREETING} until text arrives and on any error.
 */

import { useEffect, useState } from "react";

import { streamEmptyStateGreeting } from "@/domains/chat/api/stream-greeting";
import { DEFAULT_EMPTY_STATE_GREETING } from "@/domains/chat/utils/empty-state-constants";

export interface EmptyStateGreeting {
  /** The greeting to render (defaults until the first token streams in). */
  greeting: string;
  /** True while generating and no text has arrived yet — render a spinner. */
  isGenerating: boolean;
}

interface UseEmptyStateGreetingParams {
  assistantId: string | null | undefined;
  /** Identifies the current empty conversation; a change regenerates. */
  conversationId: string | null | undefined;
  /** Only generate while the empty state is actually shown. */
  enabled?: boolean;
}

export function useEmptyStateGreeting({
  assistantId,
  conversationId,
  enabled = true,
}: UseEmptyStateGreetingParams): EmptyStateGreeting {
  const [greeting, setGreeting] = useState("");
  // Seed from the initial params so the very first paint shows the spinner
  // rather than flashing the default greeting before the effect runs.
  const [isGenerating, setIsGenerating] = useState(() =>
    Boolean(enabled && assistantId && conversationId),
  );

  useEffect(() => {
    if (!enabled || !assistantId || !conversationId) {
      return;
    }

    const controller = new AbortController();
    let active = true;
    setGreeting("");
    setIsGenerating(true);

    streamEmptyStateGreeting({
      assistantId,
      signal: controller.signal,
      onDelta: (text) => {
        if (active) setGreeting(text);
      },
    })
      .then((text) => {
        if (!active) return;
        setGreeting(text.trim() || DEFAULT_EMPTY_STATE_GREETING);
      })
      .catch(() => {
        // Transport error, abort, or generation failure — keep whatever
        // streamed in, else fall back to a stable default.
        if (!active) return;
        setGreeting((current) => current || DEFAULT_EMPTY_STATE_GREETING);
      })
      .finally(() => {
        if (active) setIsGenerating(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [assistantId, conversationId, enabled]);

  return {
    greeting: greeting || DEFAULT_EMPTY_STATE_GREETING,
    // Only signal "generating" before the first token; once text streams in we
    // render it directly.
    isGenerating: isGenerating && greeting.length === 0,
  };
}
