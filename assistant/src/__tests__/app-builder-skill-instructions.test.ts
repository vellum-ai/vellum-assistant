import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("app-builder skill instructions", () => {
  test("uses non-CLI UI confirmation for optional profile switch", async () => {
    const skillText = await readFile(
      new URL("../config/bundled-skills/app-builder/SKILL.md", import.meta.url),
      "utf8",
    );
    const preflightStart = skillText.indexOf("### 0. Preflight");
    const preflightEnd = skillText.indexOf("### 1. Gather Requirements");
    const preflight = skillText.slice(preflightStart, preflightEnd);

    expect(preflight).not.toContain("assistant ui confirm --message");
    expect(preflight).toContain("Use the `ui_show` tool");
    expect(preflight).toContain('surface_type: "confirmation"');
    expect(preflight).toContain("await_action: true");
    expect(preflight).toContain(
      "Do not call the shell command `assistant ui confirm`",
    );
  });
});
