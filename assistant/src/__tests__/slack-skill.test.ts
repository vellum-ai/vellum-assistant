import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import type { SlackConversation } from "../messaging/providers/slack/types.js";

const BUNDLED_SKILLS_DIR = join(
  import.meta.dir,
  "..",
  "config",
  "bundled-skills",
);

describe("slack adapter isPrivate mapping", () => {
  // Inline the mapping logic to test it independently of the adapter module
  function mapIsPrivate(conv: Partial<SlackConversation>): boolean {
    return conv.is_private ?? conv.is_group ?? false;
  }

  test("public channel is not private", () => {
    expect(mapIsPrivate({ is_channel: true, is_private: false })).toBe(false);
  });

  test("private channel with is_private flag", () => {
    expect(mapIsPrivate({ is_channel: true, is_private: true })).toBe(true);
  });

  test("private channel via is_group (legacy)", () => {
    expect(mapIsPrivate({ is_group: true })).toBe(true);
  });

  test("is_private takes precedence over is_group", () => {
    expect(mapIsPrivate({ is_private: false, is_group: true })).toBe(false);
  });

  test("DM defaults to not private when flags absent", () => {
    expect(mapIsPrivate({ is_im: true })).toBe(false);
  });

  test("mpim (group DM) defaults to not private when is_private absent", () => {
    expect(mapIsPrivate({ is_mpim: true })).toBe(false);
  });

  test("undefined flags default to false", () => {
    expect(mapIsPrivate({})).toBe(false);
  });
});

describe("slack skill TOOLS.json", () => {
  const toolsPath = join(BUNDLED_SKILLS_DIR, "slack", "TOOLS.json");
  const toolsJson = JSON.parse(readFileSync(toolsPath, "utf-8"));

  test("is valid JSON with correct version", () => {
    expect(toolsJson.version).toBe(1);
    expect(Array.isArray(toolsJson.tools)).toBe(true);
  });

  test("has expected tools", () => {
    const names = toolsJson.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("slack_scan_digest");
    expect(names).toContain("slack_channel_details");
    expect(names).toContain("slack_configure_channels");
    expect(names).toContain("slack_add_reaction");
    expect(names).toContain("slack_edit_message");
    expect(names).toContain("slack_delete_message");
    expect(names).toContain("slack_leave_channel");
    expect(names).toContain("slack_channel_permissions");
  });

  test("has 8 tools total", () => {
    expect(toolsJson.tools.length).toBe(8);
  });

  test("all tools have required fields", () => {
    for (const tool of toolsJson.tools) {
      expect(tool.name).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(tool.category).toBeDefined();
      expect(tool.risk).toBeDefined();
      expect(tool.input_schema).toBeDefined();
      expect(tool.executor).toBeDefined();
      expect(tool.execution_target).toBeDefined();
    }
  });

  test("all executor files exist", () => {
    const slackSkillDir = join(BUNDLED_SKILLS_DIR, "slack");
    for (const tool of toolsJson.tools) {
      const executorPath = join(slackSkillDir, tool.executor);
      expect(() => readFileSync(executorPath)).not.toThrow();
    }
  });
});

describe("messaging skill no longer has Slack tools", () => {
  const messagingToolsPath = join(
    BUNDLED_SKILLS_DIR,
    "messaging",
    "TOOLS.json",
  );
  const messagingToolsJson = JSON.parse(
    readFileSync(messagingToolsPath, "utf-8"),
  );

  test("slack_add_reaction not in messaging TOOLS.json", () => {
    const names = messagingToolsJson.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("slack_add_reaction");
  });

  test("slack_delete_message not in messaging TOOLS.json", () => {
    const names = messagingToolsJson.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("slack_delete_message");
  });

  test("slack_leave_channel not in messaging TOOLS.json", () => {
    const names = messagingToolsJson.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("slack_leave_channel");
  });
});

describe("slack skill SKILL.md", () => {
  const skillMd = readFileSync(
    join(BUNDLED_SKILLS_DIR, "slack", "SKILL.md"),
    "utf-8",
  );

  test("has correct frontmatter name", () => {
    expect(skillMd).toContain("name: slack");
  });

  test("is user-invocable", () => {
    expect(skillMd).toContain('"user-invocable":true');
  });

  test("mentions privacy rules", () => {
    expect(skillMd).toContain("isPrivate");
    expect(skillMd).toContain("MUST NEVER be shared");
  });
});
