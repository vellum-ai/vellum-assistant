import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("app-builder skill instructions", () => {
  test("does not use blocking UI confirmation for optional profile switch", async () => {
    const skillText = await readFile(
      new URL("../config/bundled-skills/app-builder/SKILL.md", import.meta.url),
      "utf8",
    );
    const preflightStart = skillText.indexOf("### 0. Preflight");
    const preflightEnd = skillText.indexOf("### 1. Gather Requirements");
    const preflight = skillText.slice(preflightStart, preflightEnd);

    expect(preflight).not.toContain("assistant ui confirm --message");
    expect(preflight).toContain("Do not call `assistant ui confirm`");
    expect(preflight).toContain("Ask in normal conversation");
    expect(preflight).toContain("blocking UI confirmation command");
  });
});
