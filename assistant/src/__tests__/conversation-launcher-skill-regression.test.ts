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

  test("launches via the launch-conversation signal (single write, no curl)", () => {
    // One signal file per launch — the daemon creates+titles+seeds+opens.
    expect(skillContent).toContain("launch-conversation.");
    // Docker-safe path honors VELLUM_WORKSPACE_DIR.
    expect(skillContent).toContain("VELLUM_WORKSPACE_DIR");
  });

  test("uses jq -n --arg to build the JSON payload (no raw interpolation)", () => {
    expect(skillContent).toContain("jq -n");
  });

  test("payload includes the wire contract fields the daemon reads", () => {
    expect(skillContent).toContain("requestId");
    expect(skillContent).toContain("title");
    expect(skillContent).toContain("seedPrompt");
  });

  test("explicitly binds NEW_CONV_TITLE and SEED_PROMPT from the action payload", () => {
    expect(skillContent).toContain("NEW_CONV_TITLE");
    expect(skillContent).toContain("SEED_PROMPT");
  });

  test("does not issue HTTP calls — the signal handler does everything server-side", () => {
    expect(skillContent).not.toContain("curl");
    expect(skillContent).not.toContain("/v1/conversations");
    expect(skillContent).not.toContain("/v1/messages");
    expect(skillContent).not.toContain("signals/emit-event");
  });

  test("does not instruct the assistant to reply in chat after launching", () => {
    expect(skillContent).toMatch(/[Dd]on't say anything|[Nn]o chat response/);
  });
});
