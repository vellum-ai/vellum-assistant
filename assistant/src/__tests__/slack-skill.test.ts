import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import type { SlackConversation } from "../messaging/providers/slack/types.js";

const REPO_SKILLS_DIR = join(import.meta.dir, "..", "..", "..", "skills");

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

describe("slack skill has no TOOLS.json (uses Web API via CLI)", () => {
  const toolsPath = join(REPO_SKILLS_DIR, "slack", "TOOLS.json");

  test("TOOLS.json does not exist", () => {
    expect(() => readFileSync(toolsPath)).toThrow();
  });
});

describe("slack skill SKILL.md", () => {
  const skillMd = readFileSync(
    join(REPO_SKILLS_DIR, "slack", "SKILL.md"),
    "utf-8",
  );

  test("has correct frontmatter name", () => {
    expect(skillMd).toContain("name: slack");
  });

  test("mentions privacy rules", () => {
    expect(skillMd).toContain("is_private");
    expect(skillMd).toContain("must NEVER be shared");
  });
});
