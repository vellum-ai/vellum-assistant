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

// The card is reframed assistant-as-actor: `data.title` names the tool (the
// action), `subtitle` attributes it to the triggering message, and `body`
// carries the requester's words, the redacted command, and a Slack link.
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
    title: "Tool approval",
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
      surface={toolApprovalSurface("req-ta-001", {
        title: 'Assistant wants to use "bash"',
        subtitle: "in response to Alex's message in #eng",
        body: '> "can you set up the express server?"\n\nWill run: `npm install express`\n\n[View in Slack →](https://slack.com/archives/C01ABC/p1700000000000100)',
        metadata: [
          { label: "Tool", value: "bash" },
          { label: "Source", value: "Slack — #eng" },
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
        title: 'Assistant wants to use "web_search"',
        subtitle: "in response to Jordan's message in #research",
        body: '> "find the latest on the acquisition"\n\nWill run: `web_search("acme acquisition news")`\n\n[View in Slack →](https://slack.com/archives/C02DEF/p1700000000000200)',
        metadata: [
          { label: "Tool", value: "web_search" },
          { label: "Source", value: "Slack — #research" },
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
        title: 'Assistant wants to use "file_write"',
        subtitle: "in response to Casey's message",
        body: '> "update my hosts file"\n\nWill run: `file_write /etc/hosts`\n\n[View in Slack →](https://slack.com/archives/D03GHI/p1700000000000300)',
        metadata: [{ label: "Tool", value: "file_write" }],
      })}
      onAction={() => {}}
    />
  ),
};

export const LongToolContext: Story = {
  name: "Long command context",
  render: () => (
    <SurfaceRouter
      surface={toolApprovalSurface("req-ta-003", {
        title: 'Assistant wants to use "bash"',
        subtitle: "in response to Sam's message in #deploys",
        body: '> "ship 2.1.0 to prod"\n\nWill run: `curl -X POST https://api.example.com/v1/deployments -H \'Authorization: Bearer …\' -d \'{"environment":"production","version":"2.1.0"}\'`\n\n[View in Slack →](https://slack.com/archives/C04JKL/p1700000000000400)',
        metadata: [
          { label: "Tool", value: "bash" },
          { label: "Source", value: "Slack — #deploys" },
        ],
      })}
      onAction={() => {}}
    />
  ),
};

export const NoInboundTrigger: Story = {
  name: "No inbound trigger (self / scheduled)",
  render: () => (
    <SurfaceRouter
      surface={toolApprovalSurface("req-ta-004", {
        title: 'Assistant wants to use "unknown tool"',
        subtitle: "Requesting approval to run this tool",
        body: "No additional context available.",
        metadata: [{ label: "Tool", value: "unknown tool" }],
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
        ...toolApprovalSurface("req-ta-006", {
          title: 'Assistant wants to use "bash"',
          subtitle: "in response to Alex's message in #eng",
          body: '> "can you set up the express server?"\n\nWill run: `npm install express`',
          metadata: [
            { label: "Tool", value: "bash" },
            { label: "Source", value: "Slack — #eng" },
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
        ...toolApprovalSurface("req-ta-007", {
          title: 'Assistant wants to use "file_write"',
          subtitle: "in response to Casey's message",
          body: '> "update my hosts file"\n\nWill run: `file_write /etc/hosts`',
          metadata: [{ label: "Tool", value: "file_write" }],
        }),
        completed: true,
        completionSummary: "Denied",
      }}
      onAction={() => {}}
    />
  ),
};
