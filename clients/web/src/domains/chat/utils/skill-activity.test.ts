import { describe, expect, it } from "bun:test";

import {
  parseSkillExecuteActivity,
  parseSkillLoadActivity,
} from "./skill-activity";

/** A `skill_load` body shaped like the daemon's `formatToolSchemas` output. */
const LOAD_BODY = [
  "# App Builder",
  "",
  "Build persistent apps in the user's Library.",
  "",
  "## Available Tools",
  "",
  "Use `skill_execute` to call these tools.",
  "",
  "### app_create",
  "Create a new app in the Library.",
  "Parameters:",
  "- name (string, required): Display name for the app.",
  "- template (string, optional): Starter template id.",
  "",
  "### app_refresh",
  "Rebuild an existing app.",
  "Parameters:",
  "- app_id (string, required)",
  "",
].join("\n");

describe("parseSkillLoadActivity", () => {
  it("splits instructions from the Available Tools manifest", () => {
    const activity = parseSkillLoadActivity({
      input: { skill: "app-builder" },
      result: LOAD_BODY,
    });

    expect(activity.skillId).toBe("app-builder");
    expect(activity.errorMessage).toBeNull();
    expect(activity.instructions).toBe(
      "# App Builder\n\nBuild persistent apps in the user's Library.",
    );
    expect(activity.instructions).not.toContain("Available Tools");
  });

  it("parses each tool's name, description, and parameters", () => {
    const { tools } = parseSkillLoadActivity({
      input: { skill: "app-builder" },
      result: LOAD_BODY,
    });

    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({
      name: "app_create",
      description: "Create a new app in the Library.",
      fromSkill: null,
      params: [
        {
          name: "name",
          type: "string",
          required: true,
          description: "Display name for the app.",
        },
        {
          name: "template",
          type: "string",
          required: false,
          description: "Starter template id.",
        },
      ],
    });
    // A parameter printed without a description still parses.
    expect(tools[1]!.params).toEqual([
      { name: "app_id", type: "string", required: true, description: "" },
    ]);
  });

  it("attributes tools from a nested child-skill manifest", () => {
    const body = [
      "## Available Tools",
      "",
      "### parent_tool",
      "Parent-owned.",
      "",
      "### Tools from charting",
      "",
      "#### chart_render",
      "Render a chart.",
      "",
    ].join("\n");

    const { tools } = parseSkillLoadActivity({
      input: { skill: "app-builder" },
      result: body,
    });

    expect(tools.map((t) => [t.name, t.fromSkill])).toEqual([
      ["parent_tool", null],
      ["chart_render", "charting"],
    ]);
  });

  it("treats a body with no manifest as all instructions", () => {
    const activity = parseSkillLoadActivity({
      input: { skill: "document" },
      result: "# Document\n\nWrite long-form prose.",
    });

    expect(activity.tools).toEqual([]);
    expect(activity.instructions).toBe("# Document\n\nWrite long-form prose.");
  });

  it("surfaces an error body instead of instructions", () => {
    const activity = parseSkillLoadActivity({
      input: { skill: "nope" },
      result: "Error: skill 'nope' is currently unavailable",
      isError: true,
    });

    expect(activity.errorMessage).toBe(
      "Error: skill 'nope' is currently unavailable",
    );
    expect(activity.instructions).toBe("");
    expect(activity.tools).toEqual([]);
  });

  it("detects an error body from its Error: prefix without the flag", () => {
    const activity = parseSkillLoadActivity({
      input: { skill: "nope" },
      result: "Error: skill is required and must be a non-empty string",
    });

    expect(activity.errorMessage).toContain("Error:");
  });

  it("carries only the skill id while the call is still running", () => {
    const activity = parseSkillLoadActivity({ input: { skill: "app-builder" } });

    expect(activity).toEqual({
      skillId: "app-builder",
      instructions: "",
      tools: [],
      errorMessage: null,
    });
  });

  it("tolerates a missing or non-object input bag", () => {
    expect(parseSkillLoadActivity({ input: null }).skillId).toBe("");
    expect(parseSkillLoadActivity({ input: "oops" }).skillId).toBe("");
  });
});

describe("parseSkillExecuteActivity", () => {
  it("unwraps the documented envelope", () => {
    const activity = parseSkillExecuteActivity({
      tool: "app_create",
      input: { name: "Budget tracker", public: false },
      activity: "Creating your budget tracker app",
    });

    expect(activity.innerToolName).toBe("app_create");
    expect(activity.activity).toBe("Creating your budget tracker app");
    expect(activity.params).toEqual([
      { key: "name", scalar: "Budget tracker", json: null },
      { key: "public", scalar: "false", json: null },
    ]);
  });

  it("pretty-prints object and array parameters as JSON", () => {
    const { params } = parseSkillExecuteActivity({
      tool: "chart_render",
      input: { series: [1, 2], axis: { x: "time" } },
      activity: "Rendering",
    });

    expect(params[0]).toEqual({
      key: "series",
      scalar: null,
      json: "[\n  1,\n  2\n]",
    });
    expect(params[1]!.json).toBe('{\n  "x": "time"\n}');
  });

  it("recovers input passed as a JSON-encoded string", () => {
    const { params } = parseSkillExecuteActivity({
      tool: "task_create",
      input: '{"title":"Ship it"}',
      activity: "Creating a task",
    });

    expect(params).toEqual([{ key: "title", scalar: "Ship it", json: null }]);
  });

  it("keeps a non-JSON string input rather than dropping it", () => {
    const { params } = parseSkillExecuteActivity({
      tool: "document_create",
      input: "# Just some markdown",
      activity: "Writing",
    });

    expect(params).toEqual([
      { key: "input", scalar: "# Just some markdown", json: null },
    ]);
  });

  it("recovers parameters spread as siblings of the envelope keys", () => {
    const { innerToolName, params } = parseSkillExecuteActivity({
      tool: "task_create",
      input: {},
      activity: "Creating a task",
      title: "Ship it",
      priority: 2,
    });

    expect(innerToolName).toBe("task_create");
    expect(params).toEqual([
      { key: "title", scalar: "Ship it", json: null },
      { key: "priority", scalar: "2", json: null },
    ]);
  });

  it("renders a null parameter without dropping the key", () => {
    const { params } = parseSkillExecuteActivity({
      tool: "t",
      input: { cursor: null },
      activity: "",
    });

    expect(params).toEqual([{ key: "cursor", scalar: "null", json: null }]);
  });

  it("returns empty fields for a malformed envelope", () => {
    expect(parseSkillExecuteActivity(null)).toEqual({
      innerToolName: "",
      activity: "",
      params: [],
    });
  });
});
