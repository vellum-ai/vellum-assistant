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
  cardTitle: string,
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
    title: cardTitle,
    data,
    actions: [
      {
        id: `apr:${requestId}:approve_once`,
        label: "Approve",
        style: "primary",
      },
      { id: `apr:${requestId}:reject`, label: "Reject", style: "destructive" },
    ],
  };
}

export const BasicToolApproval: Story = {
  name: "Basic tool approval",
  render: () => (
    <SurfaceRouter
      surface={toolApprovalSurface("req-ta-001", "Tool Approval", {
        title: "bash",
        subtitle: "Requires your approval to run",
        body: "> Approve tool: bash — npm install express (requested by Alex)",
        metadata: [
          { label: "Requested by", value: "Alex" },
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
      surface={toolApprovalSurface("req-tg-001", "Tool Grant Request", {
        title: "web_search",
        subtitle: "Requires your approval to run",
        body: "> Approve tool: web_search — search for latest news (requested by Jordan)",
        metadata: [
          { label: "Requested by", value: "Jordan" },
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
      surface={toolApprovalSurface("req-ta-002", "Tool Approval", {
        title: "file_write",
        subtitle: "Requires your approval to run",
        body: "> Approve tool: file_write — write to /etc/hosts (requested by Casey)",
        metadata: [{ label: "Requested by", value: "Casey" }],
      })}
      onAction={() => {}}
    />
  ),
};

export const LongToolContext: Story = {
  name: "Long command context (truncated)",
  render: () => (
    <SurfaceRouter
      surface={toolApprovalSurface("req-ta-003", "Tool Approval", {
        title: "bash",
        subtitle: "Requires your approval to run",
        body: '> Approve tool: bash — curl -X POST https://api.example.com/v1/deployments -H \'Authorization: Bearer ...\' -d \'{"environment": "production", "version": "2.1.0", "rollback_on_failure": true}\' (requested by Sam)',
        metadata: [
          { label: "Requested by", value: "Sam" },
          { label: "Source", value: "slack" },
        ],
      })}
      onAction={() => {}}
    />
  ),
};

export const MinimalToolApproval: Story = {
  name: "Minimal info (unknown requester, no source)",
  render: () => (
    <SurfaceRouter
      surface={toolApprovalSurface("req-ta-004", "Tool Approval", {
        title: "unknown tool",
        subtitle: "Requires your approval to run",
        body: "No additional context available.",
        metadata: [{ label: "Requested by", value: "Unknown" }],
      })}
      onAction={() => {}}
    />
  ),
};

export const MultipleMetadataFields: Story = {
  name: "Multiple metadata fields",
  render: () => (
    <SurfaceRouter
      surface={toolApprovalSurface("req-ta-005", "Tool Approval", {
        title: "database_query",
        subtitle: "Requires your approval to run",
        body: "> Approve tool: database_query — SELECT * FROM users WHERE role = 'admin' (requested by Alex)",
        metadata: [
          { label: "Requested by", value: "Alex" },
          { label: "Source", value: "slack" },
        ],
      })}
      onAction={() => {}}
    />
  ),
};

// Withdrawn state: when the request is resolved (here, from another surface),
// the card keeps its information and the action buttons are replaced by a
// completion summary. See `approvals/guardian-card-withdrawal.ts`.
export const ResolvedApproved: Story = {
  name: "Resolved — approved (buttons withdrawn)",
  render: () => (
    <SurfaceRouter
      surface={{
        ...toolApprovalSurface("req-ta-006", "Tool Approval", {
          title: "bash",
          subtitle: "Requires your approval to run",
          body: "> Approve tool: bash — npm install express (requested by Alex)",
          metadata: [
            { label: "Requested by", value: "Alex" },
            { label: "Source", value: "slack" },
          ],
        }),
        completed: true,
        completionSummary: "Approved",
      }}
      onAction={() => {}}
    />
  ),
};

export const ResolvedDenied: Story = {
  name: "Resolved — denied (buttons withdrawn)",
  render: () => (
    <SurfaceRouter
      surface={{
        ...toolApprovalSurface("req-ta-007", "Tool Approval", {
          title: "file_write",
          subtitle: "Requires your approval to run",
          body: "> Approve tool: file_write — write to /etc/hosts (requested by Casey)",
          metadata: [{ label: "Requested by", value: "Casey" }],
        }),
        completed: true,
        completionSummary: "Denied",
      }}
      onAction={() => {}}
    />
  ),
};
