import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import type { Surface } from "@/domains/chat/types/types";

import { SurfaceRouter } from "./surface-router";

const meta: Meta = {
  title: "Chat/Surfaces/Form",
  parameters: {
    layout: "padded",
  },
  decorators: [
    (Story) => (
      <div className="max-w-[640px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj;

// Multi-page Slack-style setup wizard. Pages-only forms ship `fields: []`
// after daemon normalization, so the story data mirrors that wire shape.
const SETUP_PAGES = [
  {
    id: "create-app",
    title: "Create App",
    description: "Create a Slack app from an app manifest.",
    fields: [
      {
        id: "appName",
        type: "text",
        label: "App name",
        placeholder: "Vellum",
        required: true,
      },
    ],
  },
  {
    id: "app-token",
    title: "Generate App Token",
    description: "Generate an app-level token with the `connections:write` scope.",
    fields: [
      {
        id: "appToken",
        type: "password",
        label: "App-level token",
        placeholder: "xapp-...",
        required: true,
      },
    ],
  },
  {
    id: "install",
    title: "Install App",
    description: "Install the app to your workspace and paste the bot token.",
    fields: [
      {
        id: "botToken",
        type: "password",
        label: "Bot token",
        placeholder: "xoxb-...",
        required: true,
      },
    ],
  },
];

function makeFormSurface(overrides: Partial<Surface> = {}): Surface {
  return {
    surfaceId: "form-surface",
    surfaceType: "form",
    title: "Connect Slack",
    data: {
      fields: [],
      pages: SETUP_PAGES,
      pageLabels: { next: "Next", back: "Back", submit: "Finish setup" },
    },
    ...overrides,
  };
}

function FormPreview({ initialSurface }: { initialSurface: Surface }) {
  const [surface, setSurface] = useState(initialSurface);
  return (
    <SurfaceRouter
      surface={surface}
      onAction={(_surfaceId, actionId) => {
        setSurface((current) => ({
          ...current,
          completed: true,
          completionSummary:
            actionId === "submit" ? "Form submitted" : "Form dismissed",
        }));
      }}
    />
  );
}

// Default multi-page progress: the segment bar (no `progressStyle`).
export const SegmentBar: Story = {
  render: () => <FormPreview initialSurface={makeFormSurface()} />,
};

// Multi-page progress rendered as labeled step tabs.
export const LabeledTabs: Story = {
  render: () => (
    <FormPreview
      initialSurface={makeFormSurface({
        data: {
          fields: [],
          progressStyle: "tabs",
          pages: SETUP_PAGES,
          pageLabels: { next: "Next", back: "Back", submit: "Finish setup" },
        },
      })}
    />
  ),
};

// Single-page form (top-level fields, no pages) — no progress indicator.
export const SinglePage: Story = {
  render: () => (
    <FormPreview
      initialSurface={makeFormSurface({
        title: "Add API key",
        data: {
          description: "Paste the API key for this integration.",
          fields: [
            {
              id: "apiKey",
              type: "password",
              label: "API key",
              placeholder: "sk-...",
              required: true,
            },
          ],
          submitLabel: "Save",
        },
      })}
    />
  ),
};

// A one-page `pages` payload that opts into tabs: the tab strip is skipped
// (a single step), but the page title is still shown.
export const SinglePageTabs: Story = {
  render: () => (
    <FormPreview
      initialSurface={makeFormSurface({
        data: {
          fields: [],
          progressStyle: "tabs",
          pages: SETUP_PAGES.slice(0, 1),
          pageLabels: { submit: "Create app" },
        },
      })}
    />
  ),
};

// Completed state rendered by the router.
export const Completed: Story = {
  render: () => (
    <SurfaceRouter
      surface={makeFormSurface({
        completed: true,
        completionSummary: "Slack connected",
      })}
      onAction={() => {}}
    />
  ),
};
