
import { useEffect, useState } from "react";

import type { GalleryEntry } from "@/app/ui-gallery/_gallery.js";
import type { Surface } from "@/domains/chat/lib/types.js";

import { CardSurface } from "@/components/surfaces/card-surface.js";

function noopAction() {}

function makeTaskProgressSurface(
  templateData: Record<string, unknown>,
  overrides: Partial<Surface> = {},
): Surface {
  return {
    surfaceId: "gallery-task-progress",
    surfaceType: "card",
    data: {
      title: "",
      body: "",
      template: "task_progress",
      templateData,
    },
    ...overrides,
  };
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="max-w-md">{children}</div>;
}

function StepsMixedStatuses() {
  return (
    <Frame>
      <CardSurface
        surface={makeTaskProgressSurface({
          title: "Deploy workflow",
          steps: [
            { id: "1", label: "Resolve dependencies", status: "completed" },
            { id: "2", label: "Build artifacts", status: "in_progress" },
            { id: "3", label: "Run smoke tests", status: "waiting" },
            { id: "4", label: "Publish release notes", status: "failed" },
            { id: "5", label: "Notify subscribers" },
          ],
        })}
        onAction={noopAction}
      />
    </Frame>
  );
}

function StepsOverallStatusPending() {
  return (
    <Frame>
      <CardSurface
        surface={makeTaskProgressSurface({
          title: "Refresh inventory",
          steps: [
            { id: "1", label: "Fetch records" },
            { id: "2", label: "Reconcile prices" },
            { id: "3", label: "Push updates" },
          ],
        })}
        onAction={noopAction}
      />
    </Frame>
  );
}

function StepsOverallStatusInProgress() {
  return (
    <Frame>
      <CardSurface
        surface={makeTaskProgressSurface({
          title: "Refresh inventory",
          status: "in_progress",
          steps: [
            { id: "1", label: "Fetch records", status: "completed" },
            { id: "2", label: "Reconcile prices", status: "in_progress" },
            { id: "3", label: "Push updates", status: "waiting" },
          ],
        })}
        onAction={noopAction}
      />
    </Frame>
  );
}

function StepsOverallStatusCompleted() {
  return (
    <Frame>
      <CardSurface
        surface={makeTaskProgressSurface({
          title: "Refresh inventory",
          status: "completed",
          steps: [
            { id: "1", label: "Fetch records", status: "completed" },
            { id: "2", label: "Reconcile prices", status: "completed" },
            { id: "3", label: "Push updates", status: "completed" },
          ],
        })}
        onAction={noopAction}
      />
    </Frame>
  );
}

function StepsOverallStatusFailed() {
  return (
    <Frame>
      <CardSurface
        surface={makeTaskProgressSurface({
          title: "Refresh inventory",
          status: "failed",
          steps: [
            { id: "1", label: "Fetch records", status: "completed" },
            { id: "2", label: "Reconcile prices", status: "failed" },
            { id: "3", label: "Push updates" },
          ],
        })}
        onAction={noopAction}
      />
    </Frame>
  );
}

const IN_PROGRESS_DETAIL_BITS = [
  "Authenticating",
  "Establishing TLS",
  "Negotiating protocol",
  "Fetching schema",
  "Indexing pages",
  "Almost there",
];

function useCyclingDetail(values: readonly string[], intervalMs = 1400) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const id = window.setInterval(
      () => setIndex((i) => (i + 1) % values.length),
      intervalMs,
    );
    return () => window.clearInterval(id);
  }, [values, intervalMs]);
  return values[index]!;
}

function StepsInProgressCyclingDetail() {
  const inProgressDetail = useCyclingDetail(IN_PROGRESS_DETAIL_BITS);
  return (
    <Frame>
      <CardSurface
        surface={makeTaskProgressSurface({
          title: "Connecting to image library",
          status: "in_progress",
          steps: [
            {
              id: "1",
              label: "Connecting to image library",
              status: "in_progress",
              detail: inProgressDetail,
            },
            { id: "2", label: "Indexing interior shots" },
            { id: "3", label: "Extracting color palettes" },
            { id: "4", label: "Tagging materials and finishes" },
            { id: "5", label: "Clustering by aesthetic" },
            { id: "6", label: "Saving to archive" },
          ],
        })}
        onAction={noopAction}
      />
    </Frame>
  );
}

function StepsWithDetails() {
  return (
    <Frame>
      <CardSurface
        surface={makeTaskProgressSurface({
          title: "Onboarding checklist",
          status: "in_progress",
          steps: [
            {
              id: "1",
              label: "Connect data source",
              status: "completed",
              detail: "Synced 1,284 records from Postgres in 12s",
            },
            {
              id: "2",
              label: "Train model",
              status: "in_progress",
              detail: "Epoch 3 of 10 — accuracy 0.82",
            },
            {
              id: "3",
              label: "Evaluate predictions",
              status: "waiting",
              detail: "Waiting on training to finish",
            },
            {
              id: "4",
              label: "Publish to staging",
              detail: "Runs after evaluation",
            },
          ],
        })}
        onAction={noopAction}
      />
    </Frame>
  );
}

function StepsLongList() {
  return (
    <Frame>
      <CardSurface
        surface={makeTaskProgressSurface({
          title: "Quarterly migration",
          status: "in_progress",
          steps: [
            { id: "1", label: "Inventory legacy tables", status: "completed" },
            { id: "2", label: "Generate migration scripts", status: "completed" },
            { id: "3", label: "Dry run against staging", status: "completed" },
            { id: "4", label: "Backup production data", status: "completed" },
            { id: "5", label: "Apply migrations", status: "in_progress" },
            { id: "6", label: "Verify row counts", status: "waiting" },
            { id: "7", label: "Run integration suite", status: "waiting" },
            { id: "8", label: "Decommission old service" },
          ],
        })}
        onAction={noopAction}
      />
    </Frame>
  );
}

function ProgressBarEmpty() {
  return (
    <Frame>
      <CardSurface
        surface={makeTaskProgressSurface({
          completed: 0,
          total: 5,
        })}
        onAction={noopAction}
      />
    </Frame>
  );
}

function ProgressBarPartial() {
  return (
    <Frame>
      <CardSurface
        surface={makeTaskProgressSurface({
          completed: 3,
          total: 10,
        })}
        onAction={noopAction}
      />
    </Frame>
  );
}

function ProgressBarHalf() {
  return (
    <Frame>
      <CardSurface
        surface={makeTaskProgressSurface({
          completed: 5,
          total: 10,
        })}
        onAction={noopAction}
      />
    </Frame>
  );
}

function ProgressBarComplete() {
  return (
    <Frame>
      <CardSurface
        surface={makeTaskProgressSurface({
          completed: 5,
          total: 5,
        })}
        onAction={noopAction}
      />
    </Frame>
  );
}

export const taskProgressSurfaceGallery: GalleryEntry = {
  name: "TaskProgress (CardSurface)",
  category: "Feedback",
  description:
    "Task progress rendering for assistant card surfaces (template: \"task_progress\"). Two modes: a step list (when `steps` are provided) showing per-step icons and an overall status badge, or a plain progress bar (when only `completed` / `total` are provided).",
  examples: [
    {
      title: "Steps — mixed statuses",
      description:
        "All five per-step states visible at once: completed, in_progress, waiting, failed, and pending (no status).",
      Component: StepsMixedStatuses,
    },
    {
      title: "Steps — in-progress detail cycles on the right",
      description:
        "When a step is `in_progress`, its `detail` renders on the right side of the row and slides top-down between values as the assistant streams updates.",
      Component: StepsInProgressCyclingDetail,
    },
    {
      title: "Steps — overall status: pending",
      description:
        "No overall `status` on the templateData renders the default \"Pending\" badge in the header.",
      Component: StepsOverallStatusPending,
    },
    {
      title: "Steps — overall status: in progress",
      description: "Header badge reflects an `in_progress` overall status.",
      Component: StepsOverallStatusInProgress,
    },
    {
      title: "Steps — overall status: completed",
      description: "All steps done; header badge reflects a `completed` overall status.",
      Component: StepsOverallStatusCompleted,
    },
    {
      title: "Steps — overall status: failed",
      description: "One step failed; header badge reflects a `failed` overall status.",
      Component: StepsOverallStatusFailed,
    },
    {
      title: "Steps — with detail text",
      description: "Each step may include a secondary `detail` line below its label.",
      Component: StepsWithDetails,
    },
    {
      title: "Steps — long list",
      description: "Spot-check vertical rhythm and dividers across a longer task list.",
      Component: StepsLongList,
    },
    {
      title: "Progress bar — empty (0 / 5)",
      description:
        "When no `steps` are provided, the surface falls back to a `completed` / `total` progress bar.",
      Component: ProgressBarEmpty,
    },
    {
      title: "Progress bar — partial (3 / 10)",
      description: "30% fill.",
      Component: ProgressBarPartial,
    },
    {
      title: "Progress bar — half (5 / 10)",
      description: "50% fill.",
      Component: ProgressBarHalf,
    },
    {
      title: "Progress bar — complete (5 / 5)",
      description: "100% fill.",
      Component: ProgressBarComplete,
    },
  ],
};
