import type { Meta, StoryObj } from "@storybook/react-vite";

import type { Surface } from "@/domains/chat/types/types";

import { SurfaceRouter } from "./surface-router";

const meta: Meta = {
  title: "Chat/Surfaces/ToolApprovalCard",
  parameters: {
    layout: "padded",
  },
  decorators: [
    (Story) => (
      <div className="max-w-[520px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj;

function toolApprovalSurface(
  requestId: string,
  data: {
    title: string;
    subtitle: string;
    body: string;
    metadata?: Array<{ label: string; value: string }>;
  },
): Surface {
  return {
    surfaceId: `tool-approval-${requestId}`,
    surfaceType: "card",
    title: data.title,
    data,
    actions: [
      { id: `apr:${requestId}:approve_once`, label: "Approve", style: "primary" },
      { id: `apr:${requestId}:reject`, label: "Reject", style: "destructive" },
    ],
  };
}

export const BasicToolApproval: Story = {
  name: "Basic tool approval",
  render: () => (
    <SurfaceRouter
      surface={toolApprovalSurface("req-ta-001", {
        title: "Tool Approval",
        subtitle: "Requesting approval to run this tool",
        body: "> Alex is requesting approval to use `bash` to run `npm install express`",
        metadata: [
          { label: "Tool", value: "bash" },
          { label: "Source", value: "slack" },
        ],
      })}
      onAction={() => {}}
    />
  ),
};

export const ToolGrantRequest: Story = {
  name: "Tool grant request (persistent permission)",
  render: () => (
    <SurfaceRouter
      surface={toolApprovalSurface("req-tg-001", {
        title: "Tool Grant Request",
        subtitle: "Requesting permission to use this tool",
        body: "> Jordan is requesting a grant to use `web_search` — this would allow the tool to be used without future approval prompts",
        metadata: [
          { label: "Tool", value: "web_search" },
          { label: "Source", value: "telegram" },
        ],
      })}
      onAction={() => {}}
    />
  ),
};

export const DangerousTool: Story = {
  name: "High-risk tool (file system access)",
  render: () => (
    <SurfaceRouter
      surface={toolApprovalSurface("req-ta-002", {
        title: "Tool Approval",
        subtitle: "Requesting approval to run this tool",
        body: "> Casey is requesting approval to use `file_write` to write to `/etc/hosts`",
        metadata: [
          { label: "Tool", value: "file_write" },
        ],
      })}
      onAction={() => {}}
    />
  ),
};

export const LongToolContext: Story = {
  name: "Long command context (truncated)",
  render: () => (
    <SurfaceRouter
      surface={toolApprovalSurface("req-ta-003", {
        title: "Tool Approval",
        subtitle: "Requesting approval to run this tool",
        body: "> Sam is requesting approval to use `bash` to run `curl -X POST https://api.example.com/v1/deployments -H 'Authorization: Bearer ...' -d '{\"environment\": \"production\", \"version\": \"2.1.0\", \"rollback_on_failure\": true}'`",
        metadata: [
          { label: "Tool", value: "bash" },
          { label: "Source", value: "slack" },
        ],
      })}
      onAction={() => {}}
    />
  ),
};

export const MinimalToolApproval: Story = {
  name: "Minimal info (no metadata, no source)",
  render: () => (
    <SurfaceRouter
      surface={toolApprovalSurface("req-ta-004", {
        title: "Tool Approval",
        subtitle: "Requesting approval to run this tool",
        body: "No additional context available.",
        metadata: [
          { label: "Tool", value: "unknown tool" },
        ],
      })}
      onAction={() => {}}
    />
  ),
};

export const MultipleMetadataFields: Story = {
  name: "Multiple metadata fields",
  render: () => (
    <SurfaceRouter
      surface={toolApprovalSurface("req-ta-005", {
        title: "Tool Approval",
        subtitle: "Requesting approval to run this tool",
        body: "> Alex is requesting approval to use `database_query` to run `SELECT * FROM users WHERE role = 'admin'`",
        metadata: [
          { label: "Tool", value: "database_query" },
          { label: "Source", value: "slack" },
        ],
      })}
      onAction={() => {}}
    />
  ),
};
