import { describe, expect, it } from "bun:test";

import {
  type BackgroundTaskStatus,
  backgroundTaskStatusColor,
  backgroundTaskStatusLabel,
  isActiveBackgroundTaskStatus,
} from "./background-task-status";

describe("isActiveBackgroundTaskStatus", () => {
  it("is active only while running", () => {
    expect(isActiveBackgroundTaskStatus("running")).toBe(true);
  });

  it("is inactive for terminal states", () => {
    const terminal: BackgroundTaskStatus[] = [
      "completed",
      "failed",
      "cancelled",
    ];
    for (const status of terminal) {
      expect(isActiveBackgroundTaskStatus(status)).toBe(false);
    }
  });
});

describe("backgroundTaskStatusColor", () => {
  it("maps each status to its semantic color token", () => {
    expect(backgroundTaskStatusColor("running")).toBe("var(--primary-base)");
    expect(backgroundTaskStatusColor("completed")).toBe(
      "var(--system-positive-strong)",
    );
    expect(backgroundTaskStatusColor("failed")).toBe(
      "var(--system-negative-strong)",
    );
    expect(backgroundTaskStatusColor("cancelled")).toBe("var(--text-muted)");
  });
});

describe("backgroundTaskStatusLabel", () => {
  it("returns a human-readable label for each status", () => {
    expect(backgroundTaskStatusLabel("running")).toBe("Running");
    expect(backgroundTaskStatusLabel("completed")).toBe("Completed");
    expect(backgroundTaskStatusLabel("failed")).toBe("Failed");
    expect(backgroundTaskStatusLabel("cancelled")).toBe("Cancelled");
  });
});
