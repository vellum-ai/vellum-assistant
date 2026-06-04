import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import type { Surface } from "@/domains/chat/types/types";
import type { ManagedOAuthConnectClient } from "@/domains/chat/api/managed-oauth";
import type { OAuthConnection } from "@/generated/api/types.gen";

import { OAuthConnectSurface } from "./oauth-connect-surface";
import { SurfaceRouter } from "./surface-router";

const meta: Meta = {
  title: "Chat/Surfaces/ChoiceAndCopy",
  parameters: {
    layout: "padded",
  },
  decorators: [
    (Story) => (
      <div className="max-w-[920px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj;

function makeChoiceSurface(overrides: Partial<Surface> = {}): Surface {
  return {
    surfaceId: "choice-surface",
    surfaceType: "choice",
    title: "Pick a next move",
    data: {
      description: "Choose where the assistant should start.",
      options: [
        {
          id: "inbox",
          title: "Clean up my inbox",
          description:
            "Archive low-value mail and surface the important threads.",
          recommended: true,
          data: { outcome: "inbox_cleanup" },
        },
        {
          id: "calendar",
          title: "Plan my week",
          description: "Find scheduling conflicts and protect focus blocks.",
          data: { outcome: "weekly_planning" },
        },
        {
          id: "research",
          title: "Summarize open research",
          description: "Turn scattered notes into the next concrete decision.",
          data: { outcome: "research_summary" },
        },
      ],
    },
    ...overrides,
  };
}

function makeCopyBlockSurface(overrides: Partial<Surface> = {}): Surface {
  return {
    surfaceId: "copy-block-surface",
    surfaceType: "copy_block",
    data: {
      label: "Assistant migration prompt",
      language: "text",
      text: "Summarize what you know about me, the way I like to work, recurring tasks you help with, and any instructions or workflows I should carry into a new assistant. Keep it concise but specific.",
    },
    ...overrides,
  };
}

function makeOAuthConnectSurface(overrides: Partial<Surface> = {}): Surface {
  return {
    surfaceId: "oauth-connect-surface",
    surfaceType: "oauth_connect",
    title: "Connect Google",
    data: {
      providerKey: "google",
      displayName: "Google",
      description: "Connect Gmail, Calendar, and Drive for this task.",
    },
    ...overrides,
  };
}

const storyOAuthClient: ManagedOAuthConnectClient = {
  fetchProvider: async () => ({
    provider_key: "google",
    display_name: "Google",
    description: "Gmail, Calendar, and Drive",
    dashboard_url: null,
    client_id_placeholder: null,
    requires_client_secret: false,
    logo_url: null,
    supports_managed_mode: true,
    managed_service_is_paid: false,
    feature_flag: null,
  }),
  connect: async () => {
    await new Promise((resolve) => setTimeout(resolve, 650));
    return {
      status: "connected",
      connection: {
        id: "conn-story",
        provider: "google",
        status: "ACTIVE",
        connected: true,
        account_label: "user@example.com",
        scopes_granted: ["gmail.readonly", "calendar.readonly"],
        expires_at: null,
      } as OAuthConnection,
    };
  },
};

function InteractiveSurfacePreview({
  initialSurface,
}: {
  initialSurface: Surface;
}) {
  const [surface, setSurface] = useState(initialSurface);

  return (
    <SurfaceRouter
      surface={surface}
      onAction={(_surfaceId, actionId, data) => {
        const choiceTitle =
          typeof data?.choiceTitle === "string" ? data.choiceTitle : undefined;
        const selectedTitles = Array.isArray(data?.selectedTitles)
          ? data.selectedTitles.filter(
              (title): title is string => typeof title === "string",
            )
          : [];
        const label =
          choiceTitle ??
          (selectedTitles.length === 1
            ? selectedTitles[0]
            : selectedTitles.length > 1
              ? `${selectedTitles.length} outcomes selected`
              : actionId);

        setSurface((current) => ({
          ...current,
          completed: true,
          completionSummary: `User chose: "${label}"`,
        }));
      }}
    />
  );
}

function OAuthSurfacePreview() {
  const [surface, setSurface] = useState(makeOAuthConnectSurface());
  if (surface.completed) {
    return <SurfaceRouter surface={surface} onAction={() => {}} />;
  }
  return (
    <OAuthConnectSurface
      surface={surface}
      assistantId="assistant-story"
      assistantDisplayName="Assistant"
      oauthClient={storyOAuthClient}
      onAction={(_surfaceId, _actionId, data) => {
        const providerLabel =
          typeof data?.providerLabel === "string"
            ? data.providerLabel
            : "Google";
        const accountLabel =
          typeof data?.accountLabel === "string"
            ? data.accountLabel
            : undefined;
        setSurface((current) => ({
          ...current,
          completed: true,
          completionSummary: accountLabel
            ? `Connected ${providerLabel}: ${accountLabel}`
            : `Connected ${providerLabel}`,
        }));
      }}
    />
  );
}

export const RecommendedChoice: Story = {
  render: () => (
    <InteractiveSurfacePreview initialSurface={makeChoiceSurface()} />
  ),
};

export const MultiSelectChoice: Story = {
  render: () => (
    <InteractiveSurfacePreview
      initialSurface={makeChoiceSurface({
        data: {
          description: "Pick every outcome worth doing now.",
          selectionMode: "multiple",
          submitLabel: "Run selected",
          options: [
            {
              id: "inbox",
              title: "Clean up my inbox",
              description:
                "Archive low-value mail and surface the important threads.",
              recommended: true,
            },
            {
              id: "calendar",
              title: "Plan my week",
              description:
                "Find scheduling conflicts and protect focus blocks.",
            },
            {
              id: "research",
              title: "Summarize open research",
              description:
                "Turn scattered notes into the next concrete decision.",
            },
          ],
        },
      })}
    />
  ),
};

export const CopyBlock: Story = {
  render: () => (
    <SurfaceRouter surface={makeCopyBlockSurface()} onAction={() => {}} />
  ),
};

export const OauthConnect: Story = {
  name: "OAuth Connect",
  render: () => <OAuthSurfacePreview />,
};

export const ActivationRailStack: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <SurfaceRouter surface={makeCopyBlockSurface()} onAction={() => {}} />
      <InteractiveSurfacePreview initialSurface={makeChoiceSurface()} />
      <OAuthSurfacePreview />
    </div>
  ),
};

export const CompletedChoice: Story = {
  render: () => (
    <SurfaceRouter
      surface={makeChoiceSurface({
        completed: true,
        completionSummary: 'User chose: "Clean up my inbox"',
      })}
      onAction={() => {}}
    />
  ),
};

export const CompletedOauthConnect: Story = {
  name: "Completed OAuth Connect",
  render: () => (
    <SurfaceRouter
      surface={makeOAuthConnectSurface({
        completed: true,
        completionSummary: "Connected Google: user@example.com",
      })}
      onAction={() => {}}
    />
  ),
};
