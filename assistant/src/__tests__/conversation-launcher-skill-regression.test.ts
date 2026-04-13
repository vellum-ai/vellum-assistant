import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = resolve(import.meta.dirname ?? __dirname, "..", "..", "..");
const SKILL_PATH = resolve(REPO_ROOT, "skills", "conversation-launcher", "SKILL.md");
const skillContent = readFileSync(SKILL_PATH, "utf-8");

describe("conversation-launcher skill regression", () => {
  test("uses structured UI tool, not a new tool registration", () => {
    expect(skillContent).toContain("surface_type");
    expect(skillContent).toContain("await_action");
    expect(skillContent).not.toContain("ui_show(");
  });

  test("creates conversations via POST /v1/conversations", () => {
    expect(skillContent).toContain("/v1/conversations");
    expect(skillContent).toContain("conversationKey");
  });

  test("seeds the new conversation via POST /v1/messages", () => {
    expect(skillContent).toContain("/v1/messages");
  });

  test("opens the new conversation via the emit-event signal", () => {
    expect(skillContent).toContain("open_conversation");
    expect(skillContent).toContain("signals/emit-event");
  });

  test("does not instruct the assistant to reply in chat after launching", () => {
    expect(skillContent).toMatch(/[Dd]on't say anything|[Nn]o chat response/);
  });
});
