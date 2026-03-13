import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { parseContactFile } from "./importer.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseContactFile", () => {
  test("rejects files outside the current workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "sequence-workspace-"));
    const external = mkdtempSync(join(tmpdir(), "sequence-external-"));
    tempDirs.push(workspace, external);

    const current = process.cwd();
    process.chdir(workspace);

    try {
      const externalPath = join(external, "contacts.csv");
      writeFileSync(externalPath, "email,name\nuser@example.com,User\n");

      expect(() => parseContactFile(externalPath)).toThrow(
        "file_path must be inside the current workspace.",
      );
    } finally {
      process.chdir(current);
    }
  });

  test("rejects non-csv/tsv file extensions", () => {
    const workspace = mkdtempSync(join(tmpdir(), "sequence-workspace-"));
    tempDirs.push(workspace);

    const current = process.cwd();
    process.chdir(workspace);

    try {
      const filePath = join(workspace, "secrets.txt");
      writeFileSync(filePath, "root:x:0:0:root:/root:/bin/bash\n");

      expect(() => parseContactFile(filePath)).toThrow(
        "file_path must be a .csv or .tsv file.",
      );
    } finally {
      process.chdir(current);
    }
  });

  test("does not echo raw input values in invalid email errors", () => {
    const workspace = mkdtempSync(join(tmpdir(), "sequence-workspace-"));
    tempDirs.push(workspace);

    const current = process.cwd();
    process.chdir(workspace);

    try {
      const filePath = join(workspace, "contacts.csv");
      writeFileSync(filePath, "email\nroot:x:0:0:root:/root:/bin/bash\n");

      const result = parseContactFile(filePath);

      expect(result.errors).toEqual([
        { row: 2, reason: "Invalid email format" },
      ]);
    } finally {
      process.chdir(current);
    }
  });
});
