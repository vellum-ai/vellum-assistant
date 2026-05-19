
import { useCallback, useState } from "react";

import type { GalleryEntry } from "@/app/ui-gallery/_gallery.js";
import type { ChatMessageToolCall } from "@/domains/chat/lib/api.js";

import { ToolCallProgressCard } from "@/components/tool-call-progress-card/tool-call-progress-card.js";

function makeToolCall(
  overrides: Partial<ChatMessageToolCall> & { id: string; toolName: string },
): ChatMessageToolCall {
  return {
    input: {},
    status: "completed",
    ...overrides,
  };
}

function useNow(): number {
  const [now] = useState(Date.now);
  return now;
}

function useExpandedIds(initial: string[] = []) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(initial),
  );
  const onExpandChange = useCallback((id: string, expanded: boolean) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (expanded) { next.add(id); } else { next.delete(id); }
      return next;
    });
  }, []);
  return { expandedIds, onExpandChange } as const;
}

function useCardIds() {
  const [cardIds] = useState(() => new Map<string, boolean>());
  return cardIds;
}

function SingleToolCompleted() {
  const now = useNow();
  const { expandedIds, onExpandChange } = useExpandedIds();
  const cardIds = useCardIds();
  return (
    <ToolCallProgressCard
      toolCalls={[
        makeToolCall({
          id: "single-completed",
          toolName: "bash",
          input: { command: "ls -la /Users/test/project" },
          status: "completed",
          result: "total 42\ndrwxr-xr-x  10 user  staff  320 Jan  1 12:00 .",
          startedAt: now - 3000,
          completedAt: now,
        }),
      ]}
      expandedToolCallIds={expandedIds}
      onExpandChange={onExpandChange}
      expandedCardIds={cardIds}
    />
  );
}

function MultipleToolsInProgress() {
  const now = useNow();
  const { expandedIds, onExpandChange } = useExpandedIds();
  const cardIds = useCardIds();
  return (
    <ToolCallProgressCard
      toolCalls={[
        makeToolCall({
          id: "multi-1",
          toolName: "bash",
          input: { command: "npm install" },
          status: "completed",
          result: "added 42 packages in 3.2s",
          startedAt: now - 8000,
          completedAt: now - 5000,
        }),
        makeToolCall({
          id: "multi-2",
          toolName: "file_read",
          input: { path: "/src/components/App.tsx" },
          status: "running",
          startedAt: now - 4000,
        }),
        makeToolCall({
          id: "multi-3",
          toolName: "bash",
          input: { command: "bun test" },
          status: "running",
          startedAt: now - 2000,
        }),
      ]}
      expandedToolCallIds={expandedIds}
      onExpandChange={onExpandChange}
      expandedCardIds={cardIds}
    />
  );
}

function MultipleToolsAllCompleted() {
  const now = useNow();
  const { expandedIds, onExpandChange } = useExpandedIds();
  const cardIds = useCardIds();
  return (
    <ToolCallProgressCard
      toolCalls={[
        makeToolCall({
          id: "all-done-1",
          toolName: "file_read",
          input: { path: "/src/main.tsx" },
          status: "completed",
          result: "import React from 'react';",
          startedAt: now - 15000,
          completedAt: now - 12000,
        }),
        makeToolCall({
          id: "all-done-2",
          toolName: "file_edit",
          input: { path: "/src/Config.tsx" },
          status: "completed",
          result: "File updated successfully.",
          startedAt: now - 11000,
          completedAt: now - 6000,
        }),
        makeToolCall({
          id: "all-done-3",
          toolName: "bash",
          input: { command: "bun run build" },
          status: "completed",
          result: "Build completed in 4.2s",
          startedAt: now - 5000,
          completedAt: now,
        }),
      ]}
      expandedToolCallIds={expandedIds}
      onExpandChange={onExpandChange}
      expandedCardIds={cardIds}
    />
  );
}

function WithError() {
  const now = useNow();
  const { expandedIds, onExpandChange } = useExpandedIds();
  const cardIds = useCardIds();
  return (
    <ToolCallProgressCard
      toolCalls={[
        makeToolCall({
          id: "err-1",
          toolName: "bash",
          input: { command: "npm install express" },
          status: "completed",
          result: "added 1 package in 1.2s",
          startedAt: now - 10000,
          completedAt: now - 7000,
        }),
        makeToolCall({
          id: "err-2",
          toolName: "bash",
          input: { command: "rm -rf /important" },
          status: "error",
          result: "Permission denied",
          isError: true,
          startedAt: now - 6000,
          completedAt: now - 4000,
        }),
      ]}
      expandedToolCallIds={expandedIds}
      onExpandChange={onExpandChange}
      expandedCardIds={cardIds}
    />
  );
}

function WithPermissionChipsCollapsed() {
  const now = useNow();
  const { expandedIds, onExpandChange } = useExpandedIds();
  const cardIds = useCardIds();
  return (
    <ToolCallProgressCard
      toolCalls={[
        makeToolCall({
          id: "perm-1",
          toolName: "bash",
          input: { command: "npm install express" },
          status: "completed",
          result: "added 1 package in 1.2s",
          riskLevel: "medium",
          startedAt: now - 10000,
          completedAt: now - 7000,
        }),
        makeToolCall({
          id: "perm-2",
          toolName: "file_write",
          input: { path: "/src/server.ts" },
          status: "completed",
          result: "File written successfully.",
          riskLevel: "high",
          startedAt: now - 6000,
          completedAt: now,
        }),
      ]}
      expandedToolCallIds={expandedIds}
      onExpandChange={onExpandChange}
      expandedCardIds={cardIds}
    />
  );
}

function WithInlineConfirmation() {
  const { expandedIds, onExpandChange } = useExpandedIds(["confirm-2"]);
  const cardIds = useCardIds();
  const now = useNow();
  const [, setAction] = useState<string | null>(null);
  return (
    <ToolCallProgressCard
      toolCalls={[
        makeToolCall({
          id: "confirm-1",
          toolName: "file_read",
          input: { path: "/src/main.tsx" },
          status: "completed",
          result: "import React from 'react';",
          startedAt: now - 8000,
          completedAt: now - 5000,
        }),
        makeToolCall({
          id: "confirm-2",
          toolName: "bash",
          input: { command: "npm install express" },
          status: "running",
          startedAt: now - 3000,
          pendingConfirmation: {
            requestId: "gallery-confirm",
            title: "Allow running a command on your computer?",
            toolName: "bash",
            riskLevel: "medium",
            riskReason: "Package installation",
            input: { command: "npm install express" },
            allowlistOptions: [
              { pattern: "npm install express", label: "This exact command" },
            ],
            scopeOptions: [{ scope: "project", label: "This project" }],
            persistentDecisionsAllowed: true,
          },
        }),
      ]}
      expandedToolCallIds={expandedIds}
      onExpandChange={onExpandChange}
      expandedCardIds={cardIds}
      pendingConfirmationToolCallId="confirm-2"
      isSubmittingConfirmation={false}
      onConfirmationSubmit={(decision) => setAction(decision)}
      onAllowAndCreateRule={() => setAction("allow-and-create-rule")}
    />
  );
}

export const toolCallProgressCardGallery: GalleryEntry = {
  name: "ToolCallProgressCard",
  category: "Display",
  description:
    "Collapsible progress card that groups multiple tool calls into a single summary row with status icon, headline, elapsed timer, and expandable detail chips. Matches the macOS ChatGallerySection layout.",
  examples: [
    {
      title: "Single tool, completed",
      description:
        'Shows "Completed 1 step" with a 3-second duration and a green check icon.',
      Component: SingleToolCompleted,
    },
    {
      title: "Multiple tools, in progress",
      description:
        'Shows "Running 3 steps" with a live timer. One tool completed, two still running.',
      Component: MultipleToolsInProgress,
    },
    {
      title: "Multiple tools, all completed",
      description:
        'Shows "Completed 3 steps" with total duration spanning all three tool calls.',
      Component: MultipleToolsAllCompleted,
    },
    {
      title: "With error",
      description:
        'Shows "Failed 2 steps" with red error styling. One tool succeeded, one errored.',
      Component: WithError,
    },
    {
      title: "With permission chips (collapsed)",
      description:
        "Two completed tool calls with risk levels. Click the header to collapse and see the approved permission chips in the summary row.",
      Component: WithPermissionChipsCollapsed,
    },
    {
      title: "With inline confirmation",
      description:
        "Expanded card with one completed tool call and one pending medium-risk confirmation with allowlist options.",
      Component: WithInlineConfirmation,
    },
  ],
};
