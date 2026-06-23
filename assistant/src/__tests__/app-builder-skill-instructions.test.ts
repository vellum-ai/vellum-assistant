import { readdir, readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

const skillDir = new URL(
  "../config/bundled-skills/app-builder/",
  import.meta.url,
);

async function readAllSkillMarkdown(): Promise<string> {
  const entries = await readdir(skillDir, { recursive: true });
  const contents = await Promise.all(
    entries
      .filter((name) => name.endsWith(".md"))
      .map((name) => readFile(new URL(name, skillDir), "utf8")),
  );
  return contents.join("\n");
}

describe("app-builder skill instructions", () => {
  test("lets app tools infer the active app before schema validation", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("TOOLS.json", skillDir), "utf8"),
    ) as {
      tools: Array<{
        name: string;
        input_schema?: { required?: string[] };
      }>;
    };
    const requiredFor = (name: string) =>
      manifest.tools.find((tool) => tool.name === name)?.input_schema
        ?.required ?? [];

    expect(requiredFor("app_update")).not.toContain("app_id");
    expect(requiredFor("app_refresh")).not.toContain("app_id");
    expect(requiredFor("app_generate_icon")).not.toContain("app_id");
    expect(requiredFor("app_delete")).toContain("app_id");
  });

  test("uses non-CLI UI confirmation for optional profile switch", async () => {
    const skillText = await readFile(new URL("SKILL.md", skillDir), "utf8");
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

  test("does not reference window.vellum.* APIs the sandbox no longer injects", async () => {
    const skillText = await readAllSkillMarkdown();
    // These were provided by the retired Swift macOS runtime; the current
    // web/Electron/Capacitor sandbox never injects them, so the skill must not
    // steer generated apps toward APIs that silently no-op at runtime.
    for (const removedApi of [
      "vellum.widgets",
      "vellum.confirm",
      "vellum.openLink",
      "vellum.theme",
      "vellum-theme-change",
      "vellum.data",
    ]) {
      expect(skillText).not.toContain(removedApi);
    }
  });

  test("documents the window.vellum.* APIs the sandbox actually provides", async () => {
    const skillText = await readAllSkillMarkdown();
    for (const realApi of [
      "window.vellum.sendAction",
      "window.vellum.fetch",
      "window.vellum.route",
      "relay_prompt",
      "set_view",
    ]) {
      expect(skillText).toContain(realApi);
    }
  });
});
