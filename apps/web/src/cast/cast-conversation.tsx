import { memo, useCallback, useEffect, useRef, useState } from "react";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { TranscriptMessageBody } from "@/domains/chat/transcript/transcript-message-body";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { CastTurn } from "@/cast/cast-templates";

/**
 * Watch-only conversation panel for the Cast two-panel demo. Assistant turns
 * render through the REAL chat component (`TranscriptMessageBody`) so the
 * streaming text + web_search tool chips look identical to the product; user
 * turns are a simple token-styled bubble. Everything is a scripted mock
 * (`useCastConversation`) — no model call, no backend — but it fake-streams via
 * the same `textSegments`/`toolCalls`/`contentOrder` shape the component reads,
 * so it reads as the genuine assistant working.
 */

let seq = 0;
const nextId = () => `cast-msg-${++seq}`;

type Order = Array<{ type: string; id: string }>;
type SetMsgs = React.Dispatch<React.SetStateAction<DisplayMessage[]>>;

interface Streamer {
  setMessages: SetMsgs;
  timers: number[];
}

function patch(
  setMessages: SetMsgs,
  id: string,
  fields: { textSegments: string[]; toolCalls: ChatMessageToolCall[]; contentOrder: Order },
) {
  setMessages((prev) =>
    prev.map((m) =>
      m.id === id
        ? {
            ...m,
            textSegments: [...fields.textSegments],
            toolCalls: [...fields.toolCalls],
            contentOrder: [...fields.contentOrder],
          }
        : m,
    ),
  );
}

const TTFT_MS = 430; // pause before the first token
const STEP_MS = 46; // constant gap between word groups
const SEARCH_MS = 1400; // web_search running → completed
const GAP_MS = 280; // small pause between phases

/** Fake-stream one assistant turn: TTFT → prelude → optional web_search → body.
 * All timers use RELATIVE delays (each `after` fires that many ms from now), so
 * the cadence stays constant no matter how long the turn runs. */
function runScript(s: Streamer, id: string, turn: CastTurn) {
  const { prelude, search, body } = turn.script;
  const textSegments: string[] = [];
  const toolCalls: ChatMessageToolCall[] = [];
  const order: Order = [];
  const after = (ms: number, fn: () => void) => s.timers.push(window.setTimeout(fn, ms));
  const flush = () => patch(s.setMessages, id, { textSegments, toolCalls, contentOrder: order });

  function streamText(text: string, done: () => void) {
    const idx = textSegments.length;
    textSegments.push("");
    order.push({ type: "text", id: String(idx) });
    const words = text.split(" ");
    let w = 0;
    const tick = () => {
      w = Math.min(words.length, w + 2);
      textSegments[idx] = words.slice(0, w).join(" ");
      flush();
      if (w < words.length) after(STEP_MS, tick);
      else done();
    };
    after(STEP_MS, tick);
  }

  after(TTFT_MS, () =>
    streamText(prelude, () => {
      if (!search) {
        after(GAP_MS, () => streamText(body, () => {}));
        return;
      }
      const toolId = `cast-tool-${id}`;
      toolCalls.push({ id: toolId, name: "web_search", input: { query: search.query }, startedAt: Date.now() });
      order.push({ type: "toolCall", id: toolId });
      flush();
      after(SEARCH_MS, () => {
        const k = toolCalls.findIndex((t) => t.id === toolId);
        if (k >= 0) toolCalls[k] = { ...toolCalls[k], completedAt: Date.now(), result: search.result };
        flush();
        after(GAP_MS, () => streamText(body, () => {}));
      });
    }),
  );
}

export interface CastConversation {
  messages: DisplayMessage[];
  send: (turn: CastTurn) => void;
  reset: () => void;
}

export function useCastConversation(): CastConversation {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const timersRef = useRef<number[]>([]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  const send = useCallback((turn: CastTurn) => {
    const now = Date.now();
    const userId = nextId();
    const asstId = nextId();
    setMessages((prev) => [
      ...prev,
      {
        id: userId,
        role: "user",
        textSegments: [turn.user],
        contentOrder: [{ type: "text", id: "0" }],
        timestamp: now,
      },
      { id: asstId, role: "assistant", textSegments: [], contentOrder: [], timestamp: now + 1 },
    ]);
    runScript({ setMessages, timers: timersRef.current }, asstId, turn);
  }, []);

  const reset = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    setMessages([]);
  }, []);

  return { messages, send, reset };
}

/* ---------------- render ---------------- */

const noop = () => {};

/** Memoized so only the actively-streaming message re-renders each tick;
 * completed turns keep their object reference and skip re-render. */
const AssistantRow = memo(function AssistantRow({
  message,
  assistantName,
  expandedToolCallIds,
  expandedCardIds,
  expandedThinkingKeys,
  isStreaming,
}: {
  message: DisplayMessage;
  assistantName: string;
  expandedToolCallIds: Set<string>;
  expandedCardIds: Map<string, boolean>;
  expandedThinkingKeys: Map<string, boolean>;
  isStreaming: boolean;
}) {
  return (
    <div className="cast-convo__assistant">
      <TranscriptMessageBody
        message={message}
        assistantDisplayName={assistantName}
        expandedToolCallIds={expandedToolCallIds}
        expandedCardIds={expandedCardIds}
        expandedThinkingKeys={expandedThinkingKeys}
        onSurfaceAction={noop}
        isStreaming={isStreaming}
      />
    </div>
  );
});

export function CastConversationView({
  messages,
  assistantName,
}: {
  messages: DisplayMessage[];
  assistantName: string;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [expandedToolCallIds] = useState(() => new Set<string>());
  const [expandedCardIds] = useState(() => new Map<string, boolean>());
  const [expandedThinkingKeys] = useState(() => new Map<string, boolean>());

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  return (
    <div className="cast-convo">
      <div className="cast-convo__scroll">
        {messages.length === 0 ? (
          <p className="cast-convo__idle">Watch {assistantName} get to work…</p>
        ) : (
          messages.map((m, i) =>
            m.role === "user" ? (
              <div key={m.id} className="cast-convo__user">
                {m.textSegments?.[0] ?? ""}
              </div>
            ) : (
              <AssistantRow
                key={m.id}
                message={m}
                assistantName={assistantName}
                expandedToolCallIds={expandedToolCallIds}
                expandedCardIds={expandedCardIds}
                expandedThinkingKeys={expandedThinkingKeys}
                isStreaming={i === messages.length - 1}
              />
            ),
          )
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
