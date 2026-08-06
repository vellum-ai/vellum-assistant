/**
 * Tests for the voice activity line.
 *
 * The invariant worth guarding is totality: the tool vocabulary is open
 * (plugins, MCP servers, and skills all contribute names this module has never
 * seen), and the surface this feeds is a Lock Screen the user cannot correct.
 * A label that came back empty would blank the island exactly when the
 * assistant is busiest.
 */

import { describe, expect, test } from "bun:test";

import {
  activityLabelForTool,
  approvalActivityLabel,
  GENERIC_ACTIVITY_LABEL,
} from "../activity-label.js";

describe("activityLabelForTool", () => {
  test("names what the user would say is happening, not the tool", () => {
    expect(activityLabelForTool("bash")).toBe("Running a command");
    expect(activityLabelForTool("web_search")).toBe("Searching the web");
    expect(activityLabelForTool("file_read")).toBe("Reading a file");
  });

  // Where a tool runs is not a distinction anyone glancing at a Lock Screen is
  // making.
  test("host and sandbox variants read the same", () => {
    expect(activityLabelForTool("host_bash")).toBe(
      activityLabelForTool("bash"),
    );
    expect(activityLabelForTool("host_file_read")).toBe(
      activityLabelForTool("file_read"),
    );
  });

  test("falls back by prefix for structured tool families", () => {
    expect(activityLabelForTool("browser_click")).toBe("Using the browser");
    expect(activityLabelForTool("mcp_notion_search")).toBe(
      "Using a connected app",
    );
  });

  test("every tool gets a label, including ones this module has never seen", () => {
    for (const name of [
      "slack_conversations_history",
      "",
      "a",
      "some_vendor::weird.tool/name",
    ]) {
      expect(activityLabelForTool(name)).toBe(GENERIC_ACTIVITY_LABEL);
    }
  });

  test("labels stay short enough for the slot they land in", () => {
    for (const name of [
      "bash",
      "web_search",
      "host_file_transfer",
      "computer_use",
      "ui_show",
      "unknown_tool",
    ]) {
      const label = activityLabelForTool(name);
      expect(label.length).toBeLessThanOrEqual(32);
      expect(label).not.toMatch(/[.!?]$/);
    }
  });
});

describe("approvalActivityLabel", () => {
  // The turn is not running the tool, it is waiting to be allowed to. Saying
  // the former is the misstatement this exists to stop — and the line has to
  // name *something*, or the island asks the user to approve a blank.
  test("keeps the tool's phrase and says who is being waited on", () => {
    expect(approvalActivityLabel("bash")).toBe(
      "Running a command — needs your okay",
    );
    expect(approvalActivityLabel("web_search")).toBe(
      "Searching the web — needs your okay",
    );
  });

  test("an unrecognized tool still reads as a wait", () => {
    expect(approvalActivityLabel("some_vendor_tool")).toBe(
      `${GENERIC_ACTIVITY_LABEL} — needs your okay`,
    );
  });

  // A confirmation from a proxy or network prompter has no tool behind it, and
  // "Working on it — needs your okay" would claim work that is not happening.
  test("drops the phrase entirely when there is no tool to name", () => {
    expect(approvalActivityLabel("")).toBe("Needs your okay");
  });
});
