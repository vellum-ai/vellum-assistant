import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

const readSkill = () =>
  readFile(
    new URL("../config/bundled-skills/app-builder/SKILL.md", import.meta.url),
    "utf8",
  );

describe("app-builder skill instructions", () => {
  test("uses non-CLI UI confirmation for optional profile switch", async () => {
    const skillText = await readSkill();
    const preflightStart = skillText.indexOf("### Step 0");
    const preflightEnd = skillText.indexOf("### Step 1");
    const preflight = skillText.slice(preflightStart, preflightEnd);

    expect(preflightStart).toBeGreaterThan(-1);
    expect(preflightEnd).toBeGreaterThan(preflightStart);
    expect(preflight).not.toContain("assistant ui confirm --message");
    expect(preflight).toContain("Use the `ui_show` tool");
    expect(preflight).toContain('surface_type: "confirmation"');
    expect(preflight).toContain("await_action: true");
    expect(preflight).toContain(
      "Do not call the shell command `assistant ui confirm`",
    );
  });

  test("dispatches coder workers via subagent_spawn with override_profile", async () => {
    const skillText = await readSkill();

    // The tiered workflow routes parallel workers through subagent_spawn,
    // and the per-spawn override_profile is what tier-routes them.
    expect(skillText).toContain("subagent_spawn");
    expect(skillText).toContain("override_profile");
    expect(skillText.indexOf("override_profile")).toBeGreaterThan(
      skillText.indexOf("subagent_spawn"),
    );
    // Workers land on the balanced tier; the planner/repair on quality.
    expect(skillText).toContain('override_profile: "balanced"');
  });

  test("states the compile-once rule (parent compiles, workers never compile)", async () => {
    const skillText = await readSkill();

    // Only the parent calls app_refresh, exactly once.
    expect(skillText).toContain("only the parent calls `app_refresh`");
    // Workers must never compile.
    expect(skillText).toContain("Workers NEVER compile");
  });
});
