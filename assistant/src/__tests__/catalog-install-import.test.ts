import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import JSZip from "jszip";

let workspaceDir = "";

async function zipBase64(entries: Record<string, string>): Promise<string> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) {
    zip.file(path, content);
  }
  const content = await zip.generateAsync({ type: "uint8array" });
  return Buffer.from(content).toString("base64");
}

async function importSkillFromFileInChildProcess(
  fileName: string,
  fileContent: string,
): Promise<
  { success: true; skillId: string } | { success: false; error: string }
> {
  const script = `
    const input = await new Response(Bun.stdin.stream()).json();
    const { importSkillFromFile } = await import("./src/skills/catalog-install.js");
    const result = await importSkillFromFile(input.fileName, input.fileContent);
    process.stdout.write(JSON.stringify(result));
  `;
  const proc = Bun.spawn([process.execPath, "--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VELLUM_WORKSPACE_DIR: workspaceDir,
    },
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });

  proc.stdin.write(JSON.stringify({ fileName, fileContent }));
  proc.stdin.end();

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(stderr || `child process exited with ${exitCode}`);
  }

  return JSON.parse(stdout) as
    | { success: true; skillId: string }
    | { success: false; error: string };
}

describe("importSkillFromFile", () => {
  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "skill-import-test-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    workspaceDir = "";
  });

  test("imports a ZIP archive with a root SKILL.md", async () => {
    const fileContent = await zipBase64({
      "SKILL.md": "# Example Skill\n",
      "references/context.md": "details\n",
    });

    const result = await importSkillFromFileInChildProcess(
      "Example Skill.zip",
      fileContent,
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    expect(result.skillId).toBe("example-skill");

    const skillDir = join(workspaceDir, "skills", "example-skill");
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toBe(
      "# Example Skill\n",
    );
    expect(
      readFileSync(join(skillDir, "references", "context.md"), "utf-8"),
    ).toBe("details\n");
    expect(
      readFileSync(join(workspaceDir, "skills", "SKILLS.md"), "utf-8"),
    ).toContain("- example-skill\n");

    const installMeta = JSON.parse(
      readFileSync(join(skillDir, "install-meta.json"), "utf-8"),
    ) as { origin: string; contentHash?: string };
    expect(installMeta.origin).toBe("custom");
    expect(installMeta.contentHash).toStartWith("v2:");
  });

  test("flattens the single top-level directory common in ZIP exports", async () => {
    const fileContent = await zipBase64({
      "Exported Skill/SKILL.md": "# Exported Skill\n",
      "Exported Skill/references/context.md": "details\n",
    });

    const result = await importSkillFromFileInChildProcess(
      "Exported Skill.zip",
      fileContent,
    );

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);

    const skillDir = join(workspaceDir, "skills", "exported-skill");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillDir, "Exported Skill", "SKILL.md"))).toBe(
      false,
    );
    expect(
      readFileSync(join(skillDir, "references", "context.md"), "utf-8"),
    ).toBe("details\n");
  });
});
