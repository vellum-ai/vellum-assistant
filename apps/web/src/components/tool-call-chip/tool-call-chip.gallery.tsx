
import { useState } from "react";

import type { GalleryEntry } from "@/app/ui-gallery/_gallery.js";
import type { ChatMessageToolCall } from "@/domains/chat/lib/api.js";

import { ToolCallChip } from "@/components/tool-call-chip/tool-call-chip.js";

function makeToolCall(overrides: Partial<ChatMessageToolCall> & { id: string; toolName: string }): ChatMessageToolCall {
  return {
    input: {},
    status: "completed",
    ...overrides,
  };
}

function CompletedSuccess() {
  return (
    <ToolCallChip
      toolCall={makeToolCall({
        id: "gallery-success",
        toolName: "bash",
        input: { command: "ls -la /Users/test/project" },
        status: "completed",
        result: "total 42\ndrwxr-xr-x  10 user  staff  320 Jan  1 12:00 .\ndrwxr-xr-x   5 user  staff  160 Jan  1 11:00 ..",
      })}
      defaultExpanded={false}
      onExpandChange={() => {}}
    />
  );
}

function CompletedError() {
  return (
    <ToolCallChip
      toolCall={makeToolCall({
        id: "gallery-error",
        toolName: "bash",
        input: { command: "rm -rf /important" },
        status: "error",
        result: "Permission denied",
        isError: true,
      })}
      defaultExpanded={false}
      onExpandChange={() => {}}
    />
  );
}

function FileEditSuccess() {
  return (
    <ToolCallChip
      toolCall={makeToolCall({
        id: "gallery-file-edit",
        toolName: "file_edit",
        input: { path: "/src/Config.tsx" },
        status: "completed",
        result: "File updated successfully.",
      })}
      defaultExpanded={false}
      onExpandChange={() => {}}
    />
  );
}

function InProgress() {
  return (
    <ToolCallChip
      toolCall={makeToolCall({
        id: "gallery-in-progress",
        toolName: "file_read",
        input: { path: "/src/main.tsx" },
        status: "running",
      })}
      defaultExpanded={false}
      onExpandChange={() => {}}
    />
  );
}

function PendingLowRisk() {
  const [, setAction] = useState<string | null>(null);
  return (
    <ToolCallChip
      toolCall={makeToolCall({
        id: "gallery-low-risk",
        toolName: "bash",
        input: { command: "ls -la ~/Documents" },
        status: "running",
        pendingConfirmation: {
          requestId: "gallery-low",
          title: "Allow running a command on your computer?",
          toolName: "bash",
          riskLevel: "low",
          riskReason: "echo (default)",
          input: { command: "ls -la ~/Documents" },
        },
      })}
      defaultExpanded={true}
      onExpandChange={() => {}}
      isActiveConfirmation
      isSubmittingConfirmation={false}
      onConfirmationSubmit={(decision) => setAction(decision)}
    />
  );
}

function PendingMediumRiskWithAllowlist() {
  const [, setAction] = useState<string | null>(null);
  return (
    <ToolCallChip
      toolCall={makeToolCall({
        id: "gallery-medium-risk",
        toolName: "bash",
        input: { command: "npm install express" },
        status: "running",
        pendingConfirmation: {
          requestId: "gallery-medium",
          title: "Allow running a command on your computer?",
          toolName: "bash",
          riskLevel: "medium",
          riskReason: "Package installation",
          input: { command: "npm install express" },
          allowlistOptions: [
            { pattern: "npm install express", label: "This exact command" },
          ],
          scopeOptions: [
            { scope: "project", label: "This project" },
          ],
          persistentDecisionsAllowed: true,
        },
      })}
      defaultExpanded={true}
      onExpandChange={() => {}}
      isActiveConfirmation
      isSubmittingConfirmation={false}
      onConfirmationSubmit={(decision) => setAction(decision)}
      onAllowAndCreateRule={() => setAction("allow-and-create-rule")}
    />
  );
}

function PendingHighRisk() {
  const [, setAction] = useState<string | null>(null);
  return (
    <ToolCallChip
      toolCall={makeToolCall({
        id: "gallery-high-risk",
        toolName: "file_write",
        input: { path: "/Users/me/project/main.swift" },
        status: "running",
        pendingConfirmation: {
          requestId: "gallery-high",
          title: "Allow writing to a file on your computer?",
          toolName: "file_write",
          riskLevel: "high",
          riskReason: "Filesystem write to host",
          input: { path: "/Users/me/project/main.swift" },
        },
      })}
      defaultExpanded={true}
      onExpandChange={() => {}}
      isActiveConfirmation
      isSubmittingConfirmation={false}
      onConfirmationSubmit={(decision) => setAction(decision)}
    />
  );
}

function CompletedWithRiskBadge() {
  return (
    <ToolCallChip
      toolCall={makeToolCall({
        id: "gallery-completed-risk",
        toolName: "bash",
        input: { command: "npm install" },
        status: "completed",
        result: "added 42 packages in 3.2s",
        riskLevel: "medium",
      })}
      defaultExpanded={false}
      onExpandChange={() => {}}
    />
  );
}

export const toolCallChipGallery: GalleryEntry = {
  name: "ToolCallChip",
  category: "Display",
  description:
    "Compact chip showing a tool call with status icon, expandable details, and optional inline permission confirmation prompt. Matches the macOS ToolCallChip + ToolConfirmationBubble components.",
  examples: [
    {
      title: "Completed (success)",
      description: "A bash command that completed successfully. Click to expand and see output.",
      Component: CompletedSuccess,
    },
    {
      title: "Completed (error)",
      description: "A bash command that failed with a permission error.",
      Component: CompletedError,
    },
    {
      title: "File edit (success)",
      description: "A file_edit tool call that completed successfully.",
      Component: FileEditSuccess,
    },
    {
      title: "In progress",
      description: "A tool call that is currently running.",
      Component: InProgress,
    },
    {
      title: "Pending confirmation — low risk",
      description: "Inline permission prompt for a low-risk command. Shows risk badge, Allow/Deny buttons, and Show details toggle.",
      Component: PendingLowRisk,
    },
    {
      title: "Pending confirmation — medium risk with always-allow",
      description: "Medium-risk command with allowlist options. Shows the split Allow button with \"Allow & Create Rule\" dropdown.",
      Component: PendingMediumRiskWithAllowlist,
    },
    {
      title: "Pending confirmation — high risk",
      description: "High-risk file write operation. Red risk badge, no allowlist options.",
      Component: PendingHighRisk,
    },
    {
      title: "Completed with risk badge",
      description: "A completed tool call showing the post-decision risk badge on the sub-item row.",
      Component: CompletedWithRiskBadge,
    },
  ],
};
