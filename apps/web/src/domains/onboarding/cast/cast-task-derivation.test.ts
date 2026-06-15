import { describe, expect, it } from "bun:test";

import {
  ALL_STEPS,
  FALLBACK_TASKS,
  TOOL_TASKS,
  deriveTaskSuggestions,
} from "@/domains/onboarding/cast/cast-task-derivation";

describe("deriveTaskSuggestions", () => {
  it("falls back to generic tasks when there are no memories", () => {
    const tasks = deriveTaskSuggestions([]);
    expect(tasks).toEqual(FALLBACK_TASKS.slice(0, 3));
  });

  it("always returns at most three tasks", () => {
    const tasks = deriveTaskSuggestions([
      ["reach", "Connected: Slack, Gmail, Notion, Linear"],
    ]);
    expect(tasks.length).toBeLessThanOrEqual(3);
  });

  it("derives a task from each connected tool, drawn from that tool's pool", () => {
    const tasks = deriveTaskSuggestions([["reach", "Connected: Slack, Gmail"]]);
    expect(tasks.length).toBe(3); // 2 tool tasks + 1 fallback
    expect(TOOL_TASKS["slack"]).toContain(tasks[0]);
    expect(TOOL_TASKS["gmail"]).toContain(tasks[1]);
  });

  it("maps the 'Google Calendar' label to the google-calendar slug", () => {
    const tasks = deriveTaskSuggestions([["reach", "Connected: Google Calendar"]]);
    expect(TOOL_TASKS["google-calendar"]).toContain(tasks[0]);
  });

  it("slugifies multi-word tool labels (Google Drive -> google-drive)", () => {
    const tasks = deriveTaskSuggestions([["reach", "Connected: Google Drive"]]);
    expect(TOOL_TASKS["google-drive"]).toContain(tasks[0]);
  });

  it("ignores unknown tool labels and falls back", () => {
    const tasks = deriveTaskSuggestions([["reach", "Connected: Telepathy"]]);
    expect(tasks).toEqual(FALLBACK_TASKS.slice(0, 3));
  });

  it("ignores a reach entry that is not a 'Connected:' list", () => {
    const tasks = deriveTaskSuggestions([["reach", "SMS"]]);
    expect(tasks).toEqual(FALLBACK_TASKS.slice(0, 3));
  });

  it("adds a continuation task when a brain was imported", () => {
    const tasks = deriveTaskSuggestions([["brain", "Import from: ChatGPT"]]);
    expect(tasks[0]).toBe("Pick up where I left off with my previous conversations");
    expect(tasks.length).toBe(3);
  });

  it("does not add a continuation task for a non-import brain entry", () => {
    const tasks = deriveTaskSuggestions([["brain", "Skipped"]]);
    expect(tasks).not.toContain(
      "Pick up where I left off with my previous conversations",
    );
  });

  it("fills tool + brain tasks before fallbacks, capped at three", () => {
    const tasks = deriveTaskSuggestions([
      ["reach", "Connected: Slack, Gmail"],
      ["brain", "Import from: Claude"],
    ]);
    expect(tasks.length).toBe(3);
    expect(TOOL_TASKS["slack"]).toContain(tasks[0]);
    expect(TOOL_TASKS["gmail"]).toContain(tasks[1]);
    expect(tasks[2]).toBe("Pick up where I left off with my previous conversations");
  });

  it("does not duplicate fallback tasks", () => {
    const tasks = deriveTaskSuggestions([]);
    expect(new Set(tasks).size).toBe(tasks.length);
  });
});

describe("ALL_STEPS", () => {
  it("exposes the active onboarding steps that feed task derivation", () => {
    expect(ALL_STEPS.map((s) => s.step)).toEqual(["face", "tone", "reach"]);
  });
});
