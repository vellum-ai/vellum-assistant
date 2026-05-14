import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  extractTarToDir,
  writeSkillFilesToDir,
} from "../skills/catalog-install.js";
import { makeTar } from "./helpers/tar-fixtures.js";

let tempDir: string;

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `skills-extract-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("extractTarToDir", () => {
  test("extracts valid files and detects SKILL.md", () => {
    const tar = makeTar([
      { name: "SKILL.md", content: "# demo\n" },
      { name: "scripts/run.sh", content: "echo ok\n" },
    ]);

    const foundSkillMd = extractTarToDir(tar, tempDir);

    expect(foundSkillMd).toBe(true);
    expect(readFileSync(join(tempDir, "SKILL.md"), "utf-8")).toBe("# demo\n");
    expect(readFileSync(join(tempDir, "scripts", "run.sh"), "utf-8")).toBe(
      "echo ok\n",
    );
  });

  test("rejects traversal and absolute archive paths", () => {
    const tar = makeTar([
      { name: "SKILL.md", content: "# demo\n" },
      { name: "../../escape.txt", content: "nope\n" },
      { name: "..\\..\\win-escape.txt", content: "nope\n" },
      { name: "/absolute.txt", content: "nope\n" },
      { name: "C:/windows.txt", content: "nope\n" },
    ]);

    const foundSkillMd = extractTarToDir(tar, tempDir);

    expect(foundSkillMd).toBe(true);
    expect(existsSync(join(tempDir, "escape.txt"))).toBe(false);
    expect(existsSync(join(tempDir, "win-escape.txt"))).toBe(false);
    expect(existsSync(join(tempDir, "absolute.txt"))).toBe(false);
    expect(existsSync(join(tempDir, "windows.txt"))).toBe(false);
    expect(readFileSync(join(tempDir, "SKILL.md"), "utf-8")).toBe("# demo\n");
  });

  test("does not count nested SKILL.md as a valid skill root", () => {
    const tar = makeTar([
      { name: "nested/SKILL.md", content: "# nested\n" },
      { name: "README.md", content: "# wrapper\n" },
    ]);

    const foundSkillMd = extractTarToDir(tar, tempDir);

    expect(foundSkillMd).toBe(false);
    expect(existsSync(join(tempDir, "SKILL.md"))).toBe(false);
    expect(readFileSync(join(tempDir, "nested", "SKILL.md"), "utf-8")).toBe(
      "# nested\n",
    );
  });

  test("normalizes safe relative segments before top-level SKILL.md detection", () => {
    const tar = makeTar([{ name: "wrapper/../SKILL.md", content: "# demo\n" }]);

    const foundSkillMd = extractTarToDir(tar, tempDir);

    expect(foundSkillMd).toBe(true);
    expect(readFileSync(join(tempDir, "SKILL.md"), "utf-8")).toBe("# demo\n");
  });
});

describe("writeSkillFilesToDir", () => {
  test("uses the same traversal rules as tar extraction", () => {
    const foundSkillMd = writeSkillFilesToDir(
      {
        "./SKILL.md": "# demo\n",
        "scripts/../notes.md": "ok\n",
        "../../escape.txt": "nope\n",
        "/absolute.txt": "nope\n",
      },
      tempDir,
    );

    expect(foundSkillMd).toBe(true);
    expect(readFileSync(join(tempDir, "SKILL.md"), "utf-8")).toBe("# demo\n");
    expect(readFileSync(join(tempDir, "notes.md"), "utf-8")).toBe("ok\n");
    expect(existsSync(join(tempDir, "escape.txt"))).toBe(false);
    expect(existsSync(join(tempDir, "absolute.txt"))).toBe(false);
  });
});
