import { describe, expect, test } from "bun:test";

import {
  getTaskProgressDataFromSurfaceData,
  mergeTaskProgressData,
  toSlackStreamTasks,
} from "./slack-task-progress.js";

describe("getTaskProgressDataFromSurfaceData", () => {
  test("reads title, steps, and step details from a task_progress surface", () => {
    const progress = getTaskProgressDataFromSurfaceData({
      template: "task_progress",
      templateData: {
        title: "Quick Briefing",
        steps: [
          {
            label: "Check weather",
            status: "in_progress",
            detail: "Fetching the forecast",
          },
          { label: "Summarize", status: "pending" },
        ],
      },
    });

    expect(progress).toEqual({
      title: "Quick Briefing",
      steps: [
        {
          label: "Check weather",
          status: "in_progress",
          detail: "Fetching the forecast",
        },
        { label: "Summarize", status: "pending" },
      ],
    });
  });

  test("omits a blank title and blank details", () => {
    const progress = getTaskProgressDataFromSurfaceData({
      template: "task_progress",
      templateData: {
        title: "  ",
        steps: [{ label: "Check weather", status: "pending", detail: "" }],
      },
    });

    expect(progress).toEqual({
      steps: [{ label: "Check weather", status: "pending" }],
    });
  });

  test("ignores non-task_progress surfaces", () => {
    expect(
      getTaskProgressDataFromSurfaceData({
        template: "weather_forecast",
        templateData: { steps: [] },
      }),
    ).toBeUndefined();
  });
});

describe("mergeTaskProgressData", () => {
  const existing = {
    title: "Quick Briefing",
    steps: [
      { label: "Check weather", status: "in_progress" as const },
      { label: "Summarize", status: "pending" as const },
    ],
  };

  test("keeps the existing title when a partial update omits it", () => {
    const merged = mergeTaskProgressData(existing, {
      templateData: {
        steps: [
          { label: "Check weather", status: "completed" },
          { label: "Summarize", status: "in_progress" },
        ],
      },
    });

    expect(merged).toEqual({
      title: "Quick Briefing",
      steps: [
        { label: "Check weather", status: "completed" },
        { label: "Summarize", status: "in_progress" },
      ],
    });
  });

  test("replaces the title when a partial update carries one", () => {
    const merged = mergeTaskProgressData(existing, {
      templateData: { title: "Quick Briefing (Revised)" },
    });

    expect(merged).toEqual({
      title: "Quick Briefing (Revised)",
      steps: existing.steps,
    });
  });
});

describe("toSlackStreamTasks", () => {
  test("maps steps onto Slack task cards with stable ids and details", () => {
    expect(
      toSlackStreamTasks({
        title: "Quick Briefing",
        steps: [
          {
            label: "Check weather",
            status: "completed",
            detail: "Forecast fetched",
          },
          { label: "Summarize", status: "failed" },
        ],
      }),
    ).toEqual([
      {
        id: "task-0",
        title: "Check weather",
        status: "complete",
        details: "Forecast fetched",
      },
      { id: "task-1", title: "Summarize", status: "error" },
    ]);
  });
});
