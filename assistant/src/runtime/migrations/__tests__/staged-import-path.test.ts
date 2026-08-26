import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  resolveStagedImportPath,
  RESTORE_STAGING_DIRNAME,
  StagedImportPathError,
} from "../staged-import-path.js";

function stagingWorkspace(): { workspace: string; staging: string } {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "staged-import-")));
  const staging = join(workspace, RESTORE_STAGING_DIRNAME);
  mkdirSync(staging, { recursive: true });
  return { workspace, staging };
}

describe("resolveStagedImportPath", () => {
  test("resolves a relative path inside the staging directory", () => {
    const { workspace, staging } = stagingWorkspace();
    const file = join(staging, "backup.vbundle");
    writeFileSync(file, "bundle");

    expect(
      resolveStagedImportPath(`${RESTORE_STAGING_DIRNAME}/backup.vbundle`, workspace),
    ).toBe(realpathSync(file));
  });

  test("resolves an absolute path inside the staging directory", () => {
    const { workspace, staging } = stagingWorkspace();
    const file = join(staging, "backup.vbundle");
    writeFileSync(file, "bundle");

    expect(resolveStagedImportPath(file, workspace)).toBe(realpathSync(file));
  });

  test("rejects a missing file", () => {
    const { workspace } = stagingWorkspace();
    expect(() =>
      resolveStagedImportPath(
        `${RESTORE_STAGING_DIRNAME}/missing.vbundle`,
        workspace,
      ),
    ).toThrow(StagedImportPathError);
  });

  test("rejects traversal out of the staging directory", () => {
    const { workspace } = stagingWorkspace();
    writeFileSync(join(workspace, "secret.vbundle"), "nope");

    expect(() =>
      resolveStagedImportPath(
        `${RESTORE_STAGING_DIRNAME}/../secret.vbundle`,
        workspace,
      ),
    ).toThrow(StagedImportPathError);
  });

  test("rejects a path outside the workspace", () => {
    const { workspace } = stagingWorkspace();
    const outside = join(tmpdir(), `outside-${Date.now()}.vbundle`);
    writeFileSync(outside, "nope");

    expect(() => resolveStagedImportPath(outside, workspace)).toThrow(
      StagedImportPathError,
    );
  });

  test("rejects a symlink even when it points at a staging file", () => {
    const { workspace, staging } = stagingWorkspace();
    const file = join(staging, "backup.vbundle");
    writeFileSync(file, "bundle");
    const link = join(staging, "alias.vbundle");
    symlinkSync(file, link);

    expect(() => resolveStagedImportPath(link, workspace)).toThrow(
      StagedImportPathError,
    );
  });

  test("rejects a non-.vbundle file in staging", () => {
    const { workspace, staging } = stagingWorkspace();
    const file = join(staging, "notes.txt");
    writeFileSync(file, "nope");

    expect(() =>
      resolveStagedImportPath(`${RESTORE_STAGING_DIRNAME}/notes.txt`, workspace),
    ).toThrow(StagedImportPathError);
  });

  test("rejects an empty path", () => {
    const { workspace } = stagingWorkspace();
    expect(() => resolveStagedImportPath("   ", workspace)).toThrow(
      StagedImportPathError,
    );
  });
});
