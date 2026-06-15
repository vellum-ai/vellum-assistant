import { describe, expect, it } from "bun:test";

import {
  ALL_STEPS,
  FALLBACK_TASKS,
  deriveTaskSuggestions,
} from "@/domains/onboarding/cast/cast-task-derivation";
import { CAST_TOOL_BY_SLUG } from "@/domains/onboarding/cast/cast-tools";

/** Task pool for a tool, looked up by its slug (shared registry). */
const tasksFor = (slug: string): string[] => CAST_TOOL_BY_SLUG.get(slug)!.tasks;

describe("deriveTaskSuggestions", () => {
  it("falls back to generic tasks when there are no memories", () => {
    const tasks = deriveTaskSuggestions([]);
    expect(tasks).toEqual(FALLBACK_TASKS.slice(0, 3));
  });

  it("always returns at most three tasks", () => {
    const tasks = deriveTaskSuggestions([
      ["reach", "Connected: slack, gmail, notion, linear"],
    ]);
    expect(tasks.length).toBeLessThanOrEqual(3);
  });

  it("derives a task from each connected tool, drawn from that tool's pool", () => {
    const tasks = deriveTaskSuggestions([["reach", "Connected: slack, gmail"]]);
    expect(tasks.length).toBe(3); // 2 tool tasks + 1 fallback
    expect(tasksFor("slack")).toContain(tasks[0]);
    expect(tasksFor("gmail")).toContain(tasks[1]);
  });

  it("resolves the google-calendar slug to its task pool", () => {
    const tasks = deriveTaskSuggestions([["reach", "Connected: google-calendar"]]);
    expect(tasksFor("google-calendar")).toContain(tasks[0]);
  });

  it("resolves multi-word tool slugs (google-drive)", () => {
    const tasks = deriveTaskSuggestions([["reach", "Connected: google-drive"]]);
    expect(tasksFor("google-drive")).toContain(tasks[0]);
  });

  it("ignores unknown tool slugs and falls back", () => {
    const tasks = deriveTaskSuggestions([["reach", "Connected: telepathy"]]);
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
      ["reach", "Connected: slack, gmail"],
      ["brain", "Import from: Claude"],
    ]);
    expect(tasks.length).toBe(3);
    expect(tasksFor("slack")).toContain(tasks[0]);
    expect(tasksFor("gmail")).toContain(tasks[1]);
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
