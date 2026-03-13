import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { extractTarToDir } from "../skills/catalog-install.js";

let tempDir: string;

function makeTarEntry(name: string, content: string): Buffer {
  const header = Buffer.alloc(512, 0);
  const nameBuffer = Buffer.from(name, "utf-8");
  nameBuffer.copy(header, 0, 0, Math.min(nameBuffer.length, 100));

  const mode = Buffer.from("0000644\0", "ascii");
  mode.copy(header, 100);
  Buffer.from("0000000\0", "ascii").copy(header, 108); // uid
  Buffer.from("0000000\0", "ascii").copy(header, 116); // gid

  const sizeOct = content.length.toString(8).padStart(11, "0") + "\0";
  Buffer.from(sizeOct, "ascii").copy(header, 124);

  Buffer.from("00000000000\0", "ascii").copy(header, 136); // mtime
  Buffer.from("        ", "ascii").copy(header, 148); // checksum placeholder
  header[156] = "0".charCodeAt(0);
  Buffer.from("ustar\0", "ascii").copy(header, 257);
  Buffer.from("00", "ascii").copy(header, 263);

  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i] ?? 0;
  const checksum = sum.toString(8).padStart(6, "0");
  Buffer.from(`${checksum}\0 `, "ascii").copy(header, 148);

  const data = Buffer.from(content, "utf-8");
  const paddedSize = Math.ceil(data.length / 512) * 512;
  const padded = Buffer.alloc(paddedSize, 0);
  data.copy(padded);

  return Buffer.concat([header, padded]);
}

function makeTar(entries: Array<{ name: string; content: string }>): Buffer {
  const body = entries.map((entry) => makeTarEntry(entry.name, entry.content));
  return Buffer.concat([...body, Buffer.alloc(1024, 0)]);
}

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
});
