import { describe, expect, test } from "bun:test";

import {
  normalizeOnboardingContext,
  normalizeTasks,
  normalizeTools,
  TASK_DISPLAY_LABELS,
  TOOL_DISPLAY_NAMES,
} from "../prompts/normalize-onboarding.js";
import type { OnboardingContext } from "../types/onboarding-context.js";

describe("normalizeTools", () => {
  test("known tool IDs produce display labels", () => {
    expect(normalizeTools(["github"])).toEqual(["GitHub"]);
    expect(normalizeTools(["google-calendar"])).toEqual(["Google Calendar"]);
    expect(normalizeTools(["slack"])).toEqual(["Slack"]);
    expect(normalizeTools(["notion"])).toEqual(["Notion"]);
    expect(normalizeTools(["linear"])).toEqual(["Linear"]);
    expect(normalizeTools(["gmail"])).toEqual(["Gmail"]);
    expect(normalizeTools(["google-drive"])).toEqual(["Google Drive"]);
    expect(normalizeTools(["figma"])).toEqual(["Figma"]);
    expect(normalizeTools(["jira"])).toEqual(["Jira"]);
    expect(normalizeTools(["outlook"])).toEqual(["Outlook"]);
    expect(normalizeTools(["excel"])).toEqual(["Excel"]);
    expect(normalizeTools(["apple-notes"])).toEqual(["Apple Notes"]);
  });

  test("all known tool IDs from the client onboarding UI are mapped", () => {
    const clientToolIds = [
      "gmail",
      "outlook",
      "google-calendar",
      "slack",
      "notion",
      "linear",
      "jira",
      "github",
      "figma",
      "google-drive",
      "excel",
      "apple-notes",
    ];
    expect(Object.keys(TOOL_DISPLAY_NAMES)).toEqual(
      expect.arrayContaining(clientToolIds),
    );
    expect(Object.keys(TOOL_DISPLAY_NAMES)).toHaveLength(clientToolIds.length);
  });

  test("unknown/custom tool IDs pass through with first-letter capitalization", () => {
    expect(normalizeTools(["trello"])).toEqual(["Trello"]);
    expect(normalizeTools(["asana"])).toEqual(["Asana"]);
  });

  test("mixed known and unknown IDs normalize correctly", () => {
    expect(normalizeTools(["github", "trello", "slack"])).toEqual([
      "GitHub",
      "Trello",
      "Slack",
    ]);
  });

  test("empty array produces empty array", () => {
    expect(normalizeTools([])).toEqual([]);
  });
});

describe("normalizeTasks", () => {
  test("known task IDs produce plain-language labels", () => {
    expect(normalizeTasks(["code-building"])).toEqual([
      "builds code, apps, or tools",
    ]);
    expect(normalizeTasks(["writing"])).toEqual([
      "writes docs, emails, or content",
    ]);
    expect(normalizeTasks(["research"])).toEqual([
      "does research and analysis",
    ]);
    expect(normalizeTasks(["project-management"])).toEqual([
      "plans and coordinates work",
    ]);
    expect(normalizeTasks(["scheduling"])).toEqual([
      "handles meetings, calendar, and logistics",
    ]);
    expect(normalizeTasks(["personal"])).toEqual(["handles life admin"]);
  });

  test("all six known task IDs are mapped", () => {
    const knownIds = [
      "code-building",
      "writing",
      "research",
      "project-management",
      "scheduling",
      "personal",
    ];
    expect(Object.keys(TASK_DISPLAY_LABELS)).toEqual(
      expect.arrayContaining(knownIds),
    );
    expect(Object.keys(TASK_DISPLAY_LABELS)).toHaveLength(knownIds.length);
  });

  test("unknown/custom task IDs pass through unchanged", () => {
    expect(normalizeTasks(["data-entry"])).toEqual(["data-entry"]);
    expect(normalizeTasks(["custom-workflow"])).toEqual(["custom-workflow"]);
  });

  test("mixed known and unknown IDs normalize correctly", () => {
    expect(normalizeTasks(["writing", "data-entry", "research"])).toEqual([
      "writes docs, emails, or content",
      "data-entry",
      "does research and analysis",
    ]);
  });

  test("empty array produces empty array", () => {
    expect(normalizeTasks([])).toEqual([]);
  });
});

describe("normalizeOnboardingContext", () => {
  test("maps userName to preferredName", () => {
    const ctx: OnboardingContext = {
      tools: [],
      tasks: [],
      tone: "friendly",
      userName: "Alice",
    };
    const result = normalizeOnboardingContext(ctx);
    expect(result.preferredName).toBe("Alice");
  });

  test("absent userName yields undefined preferredName", () => {
    const ctx: OnboardingContext = {
      tools: [],
      tasks: [],
      tone: "professional",
    };
    const result = normalizeOnboardingContext(ctx);
    expect(result.preferredName).toBeUndefined();
  });

  test("tone passes through", () => {
    const ctx: OnboardingContext = {
      tools: [],
      tasks: [],
      tone: "casual",
    };
    const result = normalizeOnboardingContext(ctx);
    expect(result.tone).toBe("casual");
  });

  test("assistantName passes through", () => {
    const ctx: OnboardingContext = {
      tools: [],
      tasks: [],
      tone: "friendly",
      assistantName: "Jarvis",
    };
    const result = normalizeOnboardingContext(ctx);
    expect(result.assistantName).toBe("Jarvis");
  });

  test("normalizes tools and tasks together", () => {
    const ctx: OnboardingContext = {
      tools: ["github", "trello"],
      tasks: ["code-building", "data-entry"],
      tone: "professional",
      userName: "Bob",
      assistantName: "Friday",
    };
    const result = normalizeOnboardingContext(ctx);
    expect(result).toEqual({
      preferredName: "Bob",
      commonWork: ["builds code, apps, or tools", "data-entry"],
      dailyTools: ["GitHub", "Trello"],
      tone: "professional",
      assistantName: "Friday",
    });
  });
});
