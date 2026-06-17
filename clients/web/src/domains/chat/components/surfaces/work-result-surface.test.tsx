import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router";
import { WorkResultSurface } from "@/domains/chat/components/surfaces/work-result-surface";
import type { Surface } from "@/domains/chat/types/types";

afterEach(() => {
  cleanup();
});

function makeSurface(overrides: Partial<Surface> = {}): Surface {
  return {
    surfaceId: "surface-1",
    surfaceType: "work_result",
    title: "Inbox cleaned up",
    data: {
      status: "completed",
      summary: "Archived low-signal mail and surfaced the important threads.",
      metrics: [
        { label: "Archived", value: 31, tone: "positive" },
        { label: "Needs reply", value: 2, tone: "warning" },
      ],
      sections: [
        {
          id: "attention",
          title: "Needs attention",
          type: "items",
          items: [
            {
              id: "contract",
              title: "Contract follow-up",
              description: "Alice asked for edits before tomorrow.",
              tone: "warning",
              status: "Reply today",
              metadata: [{ label: "Mailbox", value: "Work" }],
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

describe("WorkResultSurface", () => {
  test("renders metrics, sections, metadata, and action buttons", async () => {
    const onAction = mock(() => {});
    const { getByRole, getByText } = render(
      <WorkResultSurface
        surface={makeSurface({
          actions: [
            { id: "review", label: "Review", style: "primary" },
            { id: "undo", label: "Undo" },
          ],
        })}
        onAction={onAction}
      />,
    );

    expect(getByText("Inbox cleaned up")).toBeTruthy();
    expect(
      getByText("Archived low-signal mail and surfaced the important threads."),
    ).toBeTruthy();
    expect(getByText("31")).toBeTruthy();
    expect(getByText("Archived")).toBeTruthy();
    expect(getByText("Needs attention")).toBeTruthy();
    expect(getByText("Contract follow-up")).toBeTruthy();
    expect(getByText("Mailbox:")).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Review" }));

    await waitFor(() => {
      expect(onAction).toHaveBeenCalledWith("surface-1", "review", undefined);
    });
  });

  test("handles sparse data without crashing", () => {
    const { getByText } = render(
      <WorkResultSurface
        surface={makeSurface({ title: "Done", data: {} })}
        onAction={() => {}}
      />,
    );

    expect(getByText("Done")).toBeTruthy();
  });
});

describe("SurfaceRouter", () => {
  test("routes work_result surfaces", () => {
    const { queryByText, getByText } = render(
      <SurfaceRouter surface={makeSurface()} onAction={() => {}} />,
    );

    expect(queryByText("Unsupported surface type: work_result")).toBeNull();
    expect(getByText("Inbox cleaned up")).toBeTruthy();
  });
});
