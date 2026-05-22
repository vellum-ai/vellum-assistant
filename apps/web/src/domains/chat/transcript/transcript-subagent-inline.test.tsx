/**
 * PR-8 wiring: inline subagent cards render inside the message body next to
 * the spawn tool call, and the legacy bottom-of-message
 * `SubagentProgressCard` mount is gone.
 *
 * We render the real Transcript with a stub `SubagentInlineProgressCard` so
 * we can assert placement without depending on the inline card's internal
 * markup (covered by its own test file).
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

mock.module("@/domains/chat/components/chat-markdown-message.js", () => ({
  ChatMarkdownMessage: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

mock.module("@/domains/chat/components/message-hover-actions/message-hover-actions.js", () => ({
  MessageHoverActions: () => <div data-testid="hover-actions" />,
}));

mock.module("@/domains/chat/components/chat-attachments/message-attachments.js", () => ({
  MessageAttachments: () => <div data-testid="message-attachments" />,
}));

mock.module("@/domains/chat/components/surfaces/surface-router.js", () => ({
  SurfaceRouter: () => <div data-testid="surface-router" />,
}));

mock.module(
  "@/domains/chat/components/tool-call-progress-card/tool-call-progress-card.js",
  () => ({
    ToolCallProgressCard: () => <div data-testid="tool-call-progress-card" />,
  }),
);

mock.module(
  "@/domains/chat/components/subagent-inline-progress-card/subagent-inline-progress-card.js",
  () => ({
    SubagentInlineProgressCard: ({ subagentId }: { subagentId: string }) => (
      <div data-testid="subagent-inline-card" data-subagent-id={subagentId} />
    ),
  }),
);

// ---------------------------------------------------------------------------
// Subjects under test — imported AFTER mocks are registered.
// ---------------------------------------------------------------------------

import { Transcript } from "@/domains/chat/transcript/transcript.js";
import { useSubagentStore } from "@/domains/subagents/subagent-store.js";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";
import type { TranscriptItem } from "@/domains/chat/transcript/types.js";

const noop = () => {};

beforeEach(() => {
  useSubagentStore.getState().reset();
});
afterEach(() => {
  cleanup();
  useSubagentStore.getState().reset();
});
afterAll(() => {
  mock.restore();
});

function userMessage(id: string, content: string): TranscriptItem {
  const msg: DisplayMessage = {
    stableId: id,
    id,
    role: "user",
    content,
  };
  return { kind: "message", key: id, message: msg };
}

function assistantMessageWithSpawn(
  id: string,
  spawnedIds: string[],
): TranscriptItem {
  const msg: DisplayMessage = {
    stableId: id,
    id,
    role: "assistant",
    content: "spawning",
    contentOrder: spawnedIds.map((_, i) => ({
      type: "toolCall",
      id: `tc-${i}`,
    })),
    toolCalls: spawnedIds.map((subagentId, i) => ({
      id: `tc-${i}`,
      toolName: "subagent_spawn",
      input: { label: `agent-${i}`, objective: "do a thing" },
      status: "completed" as const,
      result: JSON.stringify({ subagentId, label: `agent-${i}` }),
    })),
  };
  return { kind: "message", key: id, message: msg };
}

/**
 * Assistant message with one or more `subagent_spawn` tool calls that have
 * NOT received their `tool_result` yet (status: "running"). Mirrors what we
 * see mid-stream and on reloads while a spawn is still in flight.
 */
function assistantMessageWithRunningSpawns(
  id: string,
  count: number,
): TranscriptItem {
  const msg: DisplayMessage = {
    stableId: id,
    id,
    role: "assistant",
    content: "spawning",
    contentOrder: Array.from({ length: count }, (_, i) => ({
      type: "toolCall",
      id: `tc-${i}`,
    })),
    toolCalls: Array.from({ length: count }, (_, i) => ({
      id: `tc-${i}`,
      toolName: "subagent_spawn",
      input: { label: `agent-${i}`, objective: "do a thing" },
      status: "running" as const,
      // No `result` — the daemon hasn't acked the spawn yet.
    })),
  };
  return { kind: "message", key: id, message: msg };
}

/**
 * Assistant message mixing completed and running `subagent_spawn` tool
 * calls. `entries` enumerates each call in spawn order: `subagentId` when
 * the call has resolved, or `running` when it's still in flight.
 */
function assistantMessageWithMixedSpawns(
  id: string,
  entries: Array<{ status: "running" } | { subagentId: string }>,
): TranscriptItem {
  const msg: DisplayMessage = {
    stableId: id,
    id,
    role: "assistant",
    content: "spawning",
    contentOrder: entries.map((_, i) => ({
      type: "toolCall",
      id: `tc-${i}`,
    })),
    toolCalls: entries.map((entry, i) => {
      const base = {
        id: `tc-${i}`,
        toolName: "subagent_spawn",
        input: { label: `agent-${i}`, objective: "do a thing" },
      };
      if ("subagentId" in entry) {
        return {
          ...base,
          status: "completed" as const,
          result: JSON.stringify({
            subagentId: entry.subagentId,
            label: `agent-${i}`,
          }),
        };
      }
      return { ...base, status: "running" as const };
    }),
  };
  return { kind: "message", key: id, message: msg };
}

describe("Transcript — inline subagent rendering (PR 8)", () => {
  test("renders one inline card per spawn tool call inside the message body", () => {
    const items: TranscriptItem[] = [
      userMessage("u1", "spawn two agents"),
      assistantMessageWithSpawn("a1", ["sa-1", "sa-2"]),
    ];

    const { getAllByTestId } = render(
      <Transcript
        items={items}
        onSecretSubmit={noop}
        onConfirmationDecision={noop}
        onSurfaceAction={noop}
        onRetryError={noop}
      />,
    );

    const cards = getAllByTestId("subagent-inline-card");
    expect(cards.length).toBe(2);
    expect(cards.map((c) => c.getAttribute("data-subagent-id"))).toEqual([
      "sa-1",
      "sa-2",
    ]);
  });

  test("renders no inline card when the message has no subagent_spawn calls", () => {
    const items: TranscriptItem[] = [
      userMessage("u1", "no spawn"),
      assistantMessageWithSpawn("a1", []),
    ];

    const { queryAllByTestId } = render(
      <Transcript
        items={items}
        onSecretSubmit={noop}
        onConfirmationDecision={noop}
        onSurfaceAction={noop}
        onRetryError={noop}
      />,
    );

    expect(queryAllByTestId("subagent-inline-card").length).toBe(0);
  });

  test("inline card is rendered next to its tool group (not in a separate sibling section)", () => {
    const items: TranscriptItem[] = [
      userMessage("u1", "spawn one"),
      assistantMessageWithSpawn("a1", ["sa-1"]),
    ];

    const { container, getByTestId } = render(
      <Transcript
        items={items}
        onSecretSubmit={noop}
        onConfirmationDecision={noop}
        onSurfaceAction={noop}
        onRetryError={noop}
      />,
    );

    const toolCard = container.querySelector(
      '[data-testid="tool-call-progress-card"]',
    );
    const inlineCard = getByTestId("subagent-inline-card");
    expect(toolCard).not.toBeNull();
    // The inline card must follow the tool card within the same message body.
    // `compareDocumentPosition` returns Node.DOCUMENT_POSITION_FOLLOWING (4)
    // when `inlineCard` is downstream of `toolCard`.
    const relation = toolCard!.compareDocumentPosition(inlineCard);
    expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
  });
});

describe("Transcript — running-spawn inline cards (PR 8 fix)", () => {
  test("renders inline card for a running spawn (no result) when store entry exists via parentMessageStableId", () => {
    useSubagentStore.getState().spawnSubagent({
      subagentId: "sa-running-1",
      label: "agent-0",
      objective: "do a thing",
      status: "running",
      timestamp: 1000,
      parentMessageStableId: "a1",
    });

    const items: TranscriptItem[] = [
      userMessage("u1", "spawn one"),
      assistantMessageWithRunningSpawns("a1", 1),
    ];

    const { getAllByTestId } = render(
      <Transcript
        items={items}
        onSecretSubmit={noop}
        onConfirmationDecision={noop}
        onSurfaceAction={noop}
        onRetryError={noop}
      />,
    );

    const cards = getAllByTestId("subagent-inline-card");
    expect(cards.length).toBe(1);
    expect(cards[0].getAttribute("data-subagent-id")).toBe("sa-running-1");
  });

  test("renders both cards for a mixed running + completed spawn group, preserving spawn order", () => {
    // Running spawn was emitted first; the store entry exists by the time
    // the message renders even though its tool_result hasn't arrived.
    useSubagentStore.getState().spawnSubagent({
      subagentId: "sa-running",
      label: "agent-0",
      objective: "do a thing",
      status: "running",
      timestamp: 1000,
      parentMessageStableId: "a1",
    });

    const items: TranscriptItem[] = [
      userMessage("u1", "spawn two"),
      assistantMessageWithMixedSpawns("a1", [
        { status: "running" },
        { subagentId: "sa-completed" },
      ]),
    ];

    const { getAllByTestId } = render(
      <Transcript
        items={items}
        onSecretSubmit={noop}
        onConfirmationDecision={noop}
        onSurfaceAction={noop}
        onRetryError={noop}
      />,
    );

    const cards = getAllByTestId("subagent-inline-card");
    expect(cards.map((c) => c.getAttribute("data-subagent-id"))).toEqual([
      "sa-running",
      "sa-completed",
    ]);
  });

  test("renders inline card after reload via parentMessageId (daemonMessageId) match", () => {
    // Simulates `use-conversation-history.ts` reconstructing the store from
    // history notifications, where only `parentMessageId` is known.
    useSubagentStore.getState().spawnSubagent({
      subagentId: "sa-reloaded",
      label: "agent-0",
      objective: "",
      status: "running",
      timestamp: 1000,
      parentMessageId: "daemon-uuid-123",
    });

    const msg: DisplayMessage = {
      stableId: "different-stable-id",
      id: "server-id",
      daemonMessageId: "daemon-uuid-123",
      role: "assistant",
      content: "spawning",
      contentOrder: [{ type: "toolCall", id: "tc-0" }],
      toolCalls: [
        {
          id: "tc-0",
          toolName: "subagent_spawn",
          input: { label: "agent-0", objective: "" },
          status: "running",
        },
      ],
    };

    const items: TranscriptItem[] = [
      userMessage("u1", "spawn one"),
      { kind: "message", key: "a1", message: msg },
    ];

    const { getAllByTestId } = render(
      <Transcript
        items={items}
        onSecretSubmit={noop}
        onConfirmationDecision={noop}
        onSurfaceAction={noop}
        onRetryError={noop}
      />,
    );

    const cards = getAllByTestId("subagent-inline-card");
    expect(cards.length).toBe(1);
    expect(cards[0].getAttribute("data-subagent-id")).toBe("sa-reloaded");
  });

  test("does not render a card when a running spawn has no matching store entry", () => {
    const items: TranscriptItem[] = [
      userMessage("u1", "spawn one"),
      assistantMessageWithRunningSpawns("a1", 1),
    ];

    const { queryAllByTestId } = render(
      <Transcript
        items={items}
        onSecretSubmit={noop}
        onConfirmationDecision={noop}
        onSurfaceAction={noop}
        onRetryError={noop}
      />,
    );

    expect(queryAllByTestId("subagent-inline-card").length).toBe(0);
  });
});

describe("Transcript — legacy SubagentProgressCard mount is gone (PR 8)", () => {
  test("does not render any [data-testid='subagent-progress-card'] element", () => {
    const items: TranscriptItem[] = [
      userMessage("u1", "spawn"),
      assistantMessageWithSpawn("a1", ["sa-1"]),
    ];

    const { container } = render(
      <Transcript
        items={items}
        onSecretSubmit={noop}
        onConfirmationDecision={noop}
        onSurfaceAction={noop}
        onRetryError={noop}
      />,
    );

    // The legacy bottom card used this id. PR 8 removes that mount entirely;
    // its file has also been deleted from the repo. Defensive assertion to
    // keep the test alive if anything else ever re-introduces the id.
    expect(
      container.querySelector('[data-testid="subagent-progress-card"]'),
    ).toBeNull();
  });
});
