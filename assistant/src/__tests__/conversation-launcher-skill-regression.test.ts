import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = resolve(import.meta.dirname ?? __dirname, "..", "..", "..");
const SKILL_PATH = resolve(REPO_ROOT, "skills", "conversation-launcher", "SKILL.md");
const skillContent = readFileSync(SKILL_PATH, "utf-8");

describe("conversation-launcher skill regression", () => {
  test("describes the direct surface-action contract the daemon dispatches on", () => {
    // The skill must render one `ui_show` card whose actions carry the wire
    // contract that `handleSurfaceAction`'s `launch_conversation` branch reads.
    // These five tokens are the minimum the model needs to produce a valid card.
    const requiredTokens = [
      "ui_show",
      "persistent: true",
      '_action: "launch_conversation"',
      "title",
      "seedPrompt",
    ];
    for (const token of requiredTokens) {
      expect(skillContent).toContain(token);
    }
  });

  test("does not resurrect the deprecated bash + signal-file launch flow", () => {
    // PRs 5-7 replaced the bash step that wrote a per-request signal file
    // under `<workspace>/signals/` with a direct surface-action dispatch.
    // None of the old-flow tokens should reappear.
    const forbiddenTokens = [
      "bash",
      "curl",
      "signals/",
      "jq ",
      // Deleted signal-file prefix; built from parts so the literal doesn't
      // appear in repo code (prod code should no longer reference it).
      ["launch", "conversation."].join("-"),
      "VELLUM_WORKSPACE_DIR",
      "INTERNAL_GATEWAY_BASE_URL",
      "emit-event",
    ];
    for (const token of forbiddenTokens) {
      expect(skillContent).not.toContain(token);
    }
  });
});
