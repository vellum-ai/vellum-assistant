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
    // The skill must not reference signal files, HOME-based workspace paths,
    // or shell-based plumbing — it dispatches surface actions directly.
    const forbiddenTokens = [
      "bash",
      "curl",
      "signals/",
      "jq ",
      // Signal-file prefix assembled from parts so the literal does not appear
      // in repo code grep results.
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
