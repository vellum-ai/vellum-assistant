import type { Meta, StoryObj } from "@storybook/react-vite";

import type { Surface } from "@/domains/chat/types/types";

import { SurfaceRouter } from "./surface-router";

const meta: Meta = {
  title: "Chat/Surfaces/CardSurface",
  parameters: {
    layout: "padded",
  },
  decorators: [
    (Story) => (
      <div className="max-w-[960px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj;

function cardSurface(
  id: string,
  overrides: Partial<Surface> & { data: Record<string, unknown> },
): Surface {
  return {
    surfaceId: `card-${id}`,
    surfaceType: "card",
    ...overrides,
  };
}

// ── Canonical card shapes ───────────────────────────────────────────────────

export const FullCard: Story = {
  name: "Full card (title + subtitle + body + metadata + actions)",
  render: () => (
    <SurfaceRouter
      surface={cardSurface("full", {
        title: "Deployment Summary",
        data: {
          subtitle: "Production deploy #1847",
          body: "All 42 tests passed. No breaking changes detected.\n\nThe deployment will be live in approximately 3 minutes.",
          metadata: [
            { label: "Environment", value: "Production" },
            { label: "Branch", value: "main" },
            { label: "Commit", value: "a1b2c3d" },
            { label: "Duration", value: "2m 34s" },
          ],
        },
        actions: [
          { id: "rollback", label: "Rollback", style: "destructive" },
          { id: "ok", label: "Looks Good", style: "primary" },
        ],
      })}
      onAction={() => {}}
    />
  ),
};

export const TitleOnly: Story = {
  name: "Title-only card (informational banner)",
  render: () => (
    <SurfaceRouter
      surface={cardSurface("title-only", {
        title: "Server restarted successfully",
        data: {},
      })}
      onAction={() => {}}
    />
  ),
};

export const BodyOnly: Story = {
  name: "Body-only card",
  render: () => (
    <SurfaceRouter
      surface={cardSurface("body-only", {
        data: {
          body: "The migration completed successfully. 1,247 records were updated across 3 tables.",
        },
      })}
      onAction={() => {}}
    />
  ),
};

export const ActionsOnly: Story = {
  name: "Actions-only card (confirmation prompt)",
  render: () => (
    <SurfaceRouter
      surface={cardSurface("actions-only", {
        title: "Restart the server?",
        data: {},
        actions: [
          { id: "yes", label: "Yes, restart", style: "primary" },
          { id: "no", label: "Cancel", style: "secondary" },
        ],
      })}
      onAction={() => {}}
    />
  ),
};

export const MetadataGrid: Story = {
  name: "Card with metadata grid",
  render: () => (
    <SurfaceRouter
      surface={cardSurface("metadata", {
        title: "System Status",
        data: {
          body: "All services are operational.",
          metadata: [
            { label: "CPU", value: "23%" },
            { label: "Memory", value: "4.2 GB / 8 GB" },
            { label: "Disk", value: "67% used" },
            { label: "Uptime", value: "14 days" },
            { label: "Active Connections", value: "142" },
            { label: "Last Deploy", value: "2h ago" },
          ],
        },
      })}
      onAction={() => {}}
    />
  ),
};

// ── Before / After side-by-side comparisons ─────────────────────────────────
// Each story renders two cards side-by-side:
//   Left  ("Before") - the raw model shape passed directly to the client.
//          CardSurfaceDataSchema.safeParse() strips the unknown keys (description,
//          summary, heading, etc.), so the card renders empty or missing content.
//   Right ("After")  - the same intent after daemon normalizeCardShowData()
//          maps aliases to canonical fields. The card renders with content.

function BeforeAfterPair({
  label,
  modelShape,
  normalizedShape,
}: {
  label: string;
  modelShape: {
    title?: string;
    data: Record<string, unknown>;
    actions?: Surface["actions"];
  };
  normalizedShape: {
    title?: string;
    data: Record<string, unknown>;
    actions?: Surface["actions"];
  };
}) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-gray-500">{label}</p>
      <p className="mb-1 text-xs text-gray-400">
        Model sent:{" "}
        <code className="rounded bg-gray-800 px-1 py-0.5">
          {JSON.stringify(modelShape.data)}
        </code>
      </p>
      <div className="flex gap-4">
        <div className="flex-1">
          <p className="mb-1 text-xs font-semibold text-red-400">
            Before (raw model shape)
          </p>
          <SurfaceRouter
            surface={cardSurface(`before-${label}`, modelShape)}
            onAction={() => {}}
          />
        </div>
        <div className="flex-1">
          <p className="mb-1 text-xs font-semibold text-green-400">
            After (alias recovery)
          </p>
          <SurfaceRouter
            surface={cardSurface(`after-${label}`, normalizedShape)}
            onAction={() => {}}
          />
        </div>
      </div>
    </div>
  );
}

export const BeforeAfterDescription: Story = {
  name: "Before/After: description (5 surface types use this key)",
  render: () => (
    <BeforeAfterPair
      label="description to body"
      modelShape={{
        title: "Search Results",
        data: {
          description:
            "Found 12 matching documents across 3 repositories.",
        },
      }}
      normalizedShape={{
        title: "Search Results",
        data: {
          body: "Found 12 matching documents across 3 repositories.",
        },
      }}
    />
  ),
};

export const BeforeAfterSummaryDetail: Story = {
  name: "Before/After: summary + detail (concatenated, not first-wins)",
  render: () => (
    <BeforeAfterPair
      label="summary + detail to concatenated body"
      modelShape={{
        title: "Analysis Complete",
        data: {
          summary: "All tests passed with 98% coverage.",
          detail:
            "The remaining 2% consists of error handling paths that require manual integration testing.",
        },
      }}
      normalizedShape={{
        title: "Analysis Complete",
        data: {
          body: "All tests passed with 98% coverage.\n\nThe remaining 2% consists of error handling paths that require manual integration testing.",
        },
      }}
    />
  ),
};

export const BeforeAfterHeading: Story = {
  name: "Before/After: heading (model used wrong key for title)",
  render: () => (
    <BeforeAfterPair
      label="heading to title"
      modelShape={{
        data: {
          heading: "Project Overview",
          body: "The project contains 47 source files across 12 modules.",
        },
      }}
      normalizedShape={{
        title: "Project Overview",
        data: {
          body: "The project contains 47 source files across 12 modules.",
        },
      }}
    />
  ),
};

export const BeforeAfterDescriptionWithActions: Story = {
  name: "Before/After: description + actions (confirmation prompt)",
  render: () => (
    <BeforeAfterPair
      label="description + actions"
      modelShape={{
        title: "Deploy to production?",
        data: {
          description:
            "All checks passed. Ready to deploy commit a1b2c3d to prod.",
        },
        actions: [
          { id: "deploy", label: "Deploy", style: "primary" },
          { id: "cancel", label: "Cancel", style: "secondary" },
        ],
      }}
      normalizedShape={{
        title: "Deploy to production?",
        data: {
          body: "All checks passed. Ready to deploy commit a1b2c3d to prod.",
        },
        actions: [
          { id: "deploy", label: "Deploy", style: "primary" },
          { id: "cancel", label: "Cancel", style: "secondary" },
        ],
      }}
    />
  ),
};

// ── Task progress template ──────────────────────────────────────────────────

export const TaskProgressWithSteps: Story = {
  name: "Task progress card with steps",
  render: () => (
    <SurfaceRouter
      surface={cardSurface("task-steps", {
        data: {
          template: "task_progress",
          templateData: {
            title: "Setting up environment",
            status: "in_progress",
            steps: [
              { label: "Installing dependencies", status: "completed" },
              { label: "Running migrations", status: "completed" },
              { label: "Building project", status: "in_progress" },
              { label: "Running tests", status: "pending" },
            ],
          },
        },
      })}
      onAction={() => {}}
    />
  ),
};

export const TaskProgressCompleted: Story = {
  name: "Task progress card (completed)",
  render: () => (
    <SurfaceRouter
      surface={cardSurface("task-done", {
        data: {
          template: "task_progress",
          templateData: {
            title: "Environment setup",
            status: "completed",
            steps: [
              { label: "Installing dependencies", status: "completed" },
              { label: "Running migrations", status: "completed" },
              { label: "Building project", status: "completed" },
              { label: "Running tests", status: "completed" },
            ],
          },
        },
      })}
      onAction={() => {}}
    />
  ),
};

// ── Edge cases ──────────────────────────────────────────────────────────────

export const LongBody: Story = {
  name: "Card with long markdown body",
  render: () => (
    <SurfaceRouter
      surface={cardSurface("long-body", {
        title: "Code Review Summary",
        data: {
          subtitle: "PR #1234: Add user authentication",
          body: [
            "## Changes",
            "- Added JWT token generation and validation",
            "- Implemented login/logout endpoints",
            "- Added middleware for protected routes",
            "",
            "## Issues Found",
            "1. **Missing rate limiting** on login endpoint",
            "2. Token expiry is set to 30 days \u2014 consider shorter TTL",
            "3. Password hashing uses bcrypt (good) but cost factor is only 10",
            "",
            "## Recommendation",
            "Address issues #1 and #2 before merging. Issue #3 is low priority.",
          ].join("\n"),
        },
      })}
      onAction={() => {}}
    />
  ),
};

export const ThreeActions: Story = {
  name: "Card with three action buttons",
  render: () => (
    <SurfaceRouter
      surface={cardSurface("three-actions", {
        title: "How should I handle this conflict?",
        data: {
          body: "File `src/config.ts` was modified on both branches.",
        },
        actions: [
          { id: "ours", label: "Keep ours", style: "primary" },
          { id: "theirs", label: "Keep theirs", style: "secondary" },
          {
            id: "manual",
            label: "I'll resolve manually",
            style: "destructive",
          },
        ],
      })}
      onAction={() => {}}
    />
  ),
};
