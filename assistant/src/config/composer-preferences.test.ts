import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  ComposerPreferencesPatchSchema,
  readComposerPreferences,
  updateComposerPreferences,
} from "./composer-preferences.js";

const directories: string[] = [];
function directory() {
  const value = mkdtempSync(join(tmpdir(), "composer-preferences-"));
  directories.push(value);
  return value;
}
afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});
describe("composer preferences", () => {
  test("new users retain the assistant defaults", () => {
    expect(readComposerPreferences("user-1", directory())).toEqual({
      favoriteModeIds: [],
      lastModeId: null,
      lastAutonomy: null,
    });
  });
  test("partial updates preserve unrelated choices and isolate users", () => {
    const root = directory();
    updateComposerPreferences(
      "user-1",
      { lastModeId: "quality-optimized", lastAutonomy: "low" },
      root,
    );
    const patch = ComposerPreferencesPatchSchema.safeParse({
      favoriteModeIds: ["balanced"],
    });
    expect(patch.success).toBe(true);
    if (!patch.success) {
      throw patch.error;
    }
    const result = updateComposerPreferences("user-1", patch.data, root);
    expect(result.lastModeId).toBe("quality-optimized");
    expect(result.lastAutonomy).toBe("low");
    expect(result.favoriteModeIds).toEqual(["balanced"]);
    expect(readComposerPreferences("user-2", root).lastModeId).toBeNull();
  });
  test("rejects invalid thresholds, excess favorites, and foreign fields", () => {
    for (const value of [
      { lastAutonomy: "unrestricted" },
      { favoriteModeIds: ["1", "2", "3", "4", "5", "6"] },
      { principalId: "user-2" },
    ]) {
      expect(ComposerPreferencesPatchSchema.safeParse(value).success).toBe(
        false,
      );
    }
  });
  test("deduplicates favorites and leaves no temporary files", () => {
    const root = directory();
    expect(
      updateComposerPreferences(
        "../../user-1",
        { favoriteModeIds: ["a", "a", "b"] },
        root,
      ).favoriteModeIds,
    ).toEqual(["a", "b"]);
    expect(readdirSync(join(root, "composer-preferences"))).toHaveLength(1);
  });
  test("does not overwrite corrupt preferences on a failed update", () => {
    const root = directory();
    updateComposerPreferences("user-1", {}, root);
    const path = join(
      root,
      "composer-preferences",
      readdirSync(join(root, "composer-preferences"))[0]!,
    );
    writeFileSync(path, '{"lastAutonomy":"invalid"}');
    expect(() =>
      updateComposerPreferences(
        "user-1",
        { favoriteModeIds: ["balanced"] },
        root,
      ),
    ).toThrow();
    expect(readFileSync(path, "utf8")).toBe('{"lastAutonomy":"invalid"}');
  });
});
