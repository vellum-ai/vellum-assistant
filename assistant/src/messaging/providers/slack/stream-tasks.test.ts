import { describe, expect, test } from "bun:test";

import { toSlackStreamTasks } from "./stream-tasks.js";

describe("toSlackStreamTasks", () => {
  test("maps steps onto Slack task cards with stable ids and details", () => {
    expect(
      toSlackStreamTasks([
        {
          label: "Check weather",
          status: "completed",
          detail: "Forecast fetched",
        },
        { label: "Summarize", status: "failed" },
      ]),
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
