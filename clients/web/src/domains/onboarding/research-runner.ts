/**
 * Runs the "research me" turn against the hatched assistant from inside the
 * research-onboarding route and surfaces the parsed `{ claims, suggestions }`
 * incrementally so the in-flow result steps can render real data.
 *
 * SPIKE — research-onboarding flow.
 *
 * Why this lives here (and not in the chat domain): the new in-flow result
 * steps render the research output WITH the toned backdrop, never handing off
 * to the chat surface until the user picks a suggestion. So we fire the turn
 * ourselves — mint a dedicated side conversation, post the research prompt, and
 * poll `messagesGet` — rather than relying on `ActiveChatView`'s stream. Talks
 * to the daemon through the generated SDK directly (`@/domains/chat/api/*` is
 * import-banned from onboarding), exactly like `checkin-scheduler.ts`. The
 * parser is shared via the neutral `@/utils/research-facts`.
 *
 * Best-effort: a failure never blocks the flow — the steps just fall back to
 * their loading/empty presentation. The research conversation is intentionally
 * SEPARATE from the user-facing chat the suggestion click later opens.
 */

import { useCallback, useRef, useState } from "react";

import {
  conversationsPost,
  messagesGet,
  messagesPost,
} from "@/generated/daemon/sdk.gen";
import type {
  MessagesGetResponses,
  MessagesPostData,
} from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
import {
  buildResearchPrompt,
  type ResearchSubject,
} from "@/domains/onboarding/research-prompt";
import {
  parseResearchResultStreaming,
  type ResearchFact,
  type ResearchSuggestion,
} from "@/utils/research-facts";

/** Poll cadence + ceiling for reading the streaming research reply. */
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_MS = 120_000;
/**
 * Consecutive identical non-empty reads that mark the turn settled. Two
 * matching polls (~3s apart) means generation has stopped, whether the daemon
 * persists the assistant message incrementally or only on completion.
 */
const STABLE_READS_TO_SETTLE = 2;

export type ResearchStatus = "idle" | "running" | "done" | "error";

export interface ResearchRunnerState {
  status: ResearchStatus;
  claims: ResearchFact[];
  suggestions: ResearchSuggestion[];
}

export interface StartResearchOptions {
  /** Resolves with the hatched assistant id once it's healthy. */
  awaitAssistantId: () => Promise<string>;
  subject: ResearchSubject;
  /** Friendly title for the behind-the-scenes research conversation. */
  conversationTitle?: string;
}

export interface UseResearchRunner extends ResearchRunnerState {
  /**
   * Fire the research turn. Keyed by subject: calling again with the same
   * subject is a no-op, but resubmitting with EDITED details (e.g. the user
   * stepped back and changed their name/role) restarts the run and cancels the
   * stale poll loop so the results reflect the corrected subject.
   */
  start: (options: StartResearchOptions) => void;
}

type GetMessage = MessagesGetResponses[200]["messages"][number];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Latest assistant reply text from a messages list (text blocks, then legacy flat content). */
function latestAssistantText(messages: GetMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const blocks = m.contentBlocks;
    if (blocks && blocks.length > 0) {
      const text = blocks
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
    return (m.content ?? "").trim();
  }
  return "";
}

export function useResearchRunner(): UseResearchRunner {
  const [state, setState] = useState<ResearchRunnerState>({
    status: "idle",
    claims: [],
    suggestions: [],
  });
  // Monotonic run id: every fresh run claims the next id; in-flight loops bail
  // the moment a newer run supersedes them. Paired with the last subject key so
  // an identical resubmit is a no-op but an edited one restarts.
  const runIdRef = useRef(0);
  const subjectKeyRef = useRef<string | null>(null);

  const start = useCallback(
    ({ awaitAssistantId, subject, conversationTitle }: StartResearchOptions) => {
      const subjectKey = JSON.stringify(subject);
      if (subjectKeyRef.current === subjectKey) return;
      subjectKeyRef.current = subjectKey;
      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      const isStale = () => runIdRef.current !== runId;
      setState({ status: "running", claims: [], suggestions: [] });

      void (async () => {
        try {
          const assistantId = await awaitAssistantId();
          if (isStale()) return;

          const conversation = await conversationsPost({
            path: { assistant_id: assistantId },
            body: {
              conversationType: "standard",
              ...(conversationTitle ? { title: conversationTitle } : {}),
            },
            throwOnError: false,
          });
          if (isStale()) return;
          const conversationId = conversation.data?.id;
          if (!conversation.response?.ok || !conversationId) {
            setState((s) => ({ ...s, status: "error" }));
            return;
          }

          const body: MessagesPostData["body"] = {
            conversationId,
            content: buildResearchPrompt(subject),
            sourceChannel: "vellum",
            interface: "vellum",
            clientMessageId: crypto.randomUUID(),
          };
          // Carry the browser timezone so any time-relative reasoning resolves
          // to the user's local clock. Mirrors `checkin-scheduler.ts`.
          try {
            const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            if (tz) body.clientTimezone = tz;
          } catch {
            // Intl unavailable — daemon falls back to its own cascade.
          }

          const posted = await messagesPost({
            path: { assistant_id: assistantId },
            body,
            throwOnError: false,
          });
          if (isStale()) return;
          if (!posted.response?.ok) {
            setState((s) => ({ ...s, status: "error" }));
            return;
          }

          // Poll the conversation, parsing the (possibly partial) reply each
          // pass so claims/suggestions surface as they land. Settle once the
          // reply text stops changing.
          const deadline = Date.now() + MAX_POLL_MS;
          let lastText = "";
          let stableReads = 0;
          while (Date.now() < deadline) {
            await sleep(POLL_INTERVAL_MS);
            if (isStale()) return;
            const listed = await messagesGet({
              path: { assistant_id: assistantId },
              query: { conversationId },
              throwOnError: false,
            });
            if (isStale()) return;
            const messages = listed.data?.messages ?? [];
            const text = latestAssistantText(messages);
            if (text) {
              const { claims, suggestions } = parseResearchResultStreaming(text);
              setState({ status: "running", claims, suggestions });
              stableReads = text === lastText ? stableReads + 1 : 0;
              lastText = text;
              if (stableReads >= STABLE_READS_TO_SETTLE) break;
            }
          }

          if (isStale()) return;
          setState((s) => ({ ...s, status: "done" }));
        } catch (err) {
          if (isStale()) return;
          captureError(err, { context: "research_onboarding_runner" });
          setState((s) => ({ ...s, status: "error" }));
        }
      })();
    },
    [],
  );

  return { ...state, start };
}
