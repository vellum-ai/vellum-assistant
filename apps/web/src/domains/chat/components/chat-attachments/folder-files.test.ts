import { describe, expect, test } from "bun:test";

import {
  FOLDER_FILE_LIMIT,
  filterFolderFiles,
  shouldIgnoreFolderPath,
} from "./folder-files";

/** Build a File whose webkitRelativePath reports the given folder path. */
function fileAt(relativePath: string): File {
  const name = relativePath.split("/").pop() ?? relativePath;
  const file = new File(["x"], name, { type: "text/plain" });
  Object.defineProperty(file, "webkitRelativePath", {
    value: relativePath,
    configurable: true,
  });
  return file;
}

describe("shouldIgnoreFolderPath", () => {
  test("keeps ordinary source files", () => {
    expect(shouldIgnoreFolderPath("proj/src/index.ts")).toBe(false);
    expect(shouldIgnoreFolderPath("README.md")).toBe(false);
  });

  test("skips dependency and build directories anywhere in the tree", () => {
    expect(shouldIgnoreFolderPath("proj/node_modules/lib/index.js")).toBe(true);
    expect(shouldIgnoreFolderPath("proj/dist/bundle.js")).toBe(true);
    expect(shouldIgnoreFolderPath("proj/.git/HEAD")).toBe(true);
  });

  test("skips hidden directories but keeps leaf dotfiles", () => {
    expect(shouldIgnoreFolderPath("proj/.cache/x")).toBe(true);
    expect(shouldIgnoreFolderPath("proj/.idea/workspace.xml")).toBe(true);
    expect(shouldIgnoreFolderPath("proj/.env")).toBe(false);
  });

  test("skips OS junk files", () => {
    expect(shouldIgnoreFolderPath("proj/.DS_Store")).toBe(true);
    expect(shouldIgnoreFolderPath("proj/sub/Thumbs.db")).toBe(true);
  });
});

describe("filterFolderFiles", () => {
  test("partitions accepted vs ignored", () => {
    const result = filterFolderFiles([
      fileAt("proj/src/a.ts"),
      fileAt("proj/node_modules/b.js"),
      fileAt("proj/.DS_Store"),
      fileAt("proj/README.md"),
    ]);
    expect(result.accepted.map((f) => f.name)).toEqual(["a.ts", "README.md"]);
    expect(result.ignored).toBe(2);
    expect(result.truncated).toBe(false);
  });

  test("caps the result at FOLDER_FILE_LIMIT and flags truncation", () => {
    const files = Array.from({ length: FOLDER_FILE_LIMIT + 5 }, (_, i) =>
      fileAt(`proj/src/file-${i}.ts`),
    );
    const result = filterFolderFiles(files);
    expect(result.accepted.length).toBe(FOLDER_FILE_LIMIT);
    expect(result.truncated).toBe(true);
  });
});
