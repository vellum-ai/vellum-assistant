import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

const existsSyncFn = mock((_path: string): boolean => false);
const renameSyncFn = mock(() => {});

// ---------------------------------------------------------------------------
// Mock modules — before importing module under test
// ---------------------------------------------------------------------------

mock.module("node:fs", () => ({
  existsSync: existsSyncFn,
  renameSync: renameSyncFn,
}));

// Import after mocking
import { avatarRenameMigration } from "../workspace/migrations/001-avatar-rename.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = "/tmp/test-workspace";
const AVATAR_DIR = `${WORKSPACE_DIR}/data/avatar`;

const OLD_IMAGE = `${AVATAR_DIR}/custom-avatar.png`;
const NEW_IMAGE = `${AVATAR_DIR}/avatar-image.png`;
const OLD_TRAITS = `${AVATAR_DIR}/avatar-components.json`;
const NEW_TRAITS = `${AVATAR_DIR}/character-traits.json`;

function setupExistsSync(mapping: Record<string, boolean>) {
  existsSyncFn.mockImplementation((path: string) => mapping[path] ?? false);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("001-avatar-rename migration", () => {
  beforeEach(() => {
    existsSyncFn.mockClear();
    renameSyncFn.mockClear();
  });

  test("renames both files when old names exist", () => {
    setupExistsSync({
      [OLD_IMAGE]: true,
      [NEW_IMAGE]: false,
      [OLD_TRAITS]: true,
      [NEW_TRAITS]: false,
    });

    avatarRenameMigration.run(WORKSPACE_DIR);

    expect(renameSyncFn).toHaveBeenCalledTimes(2);
    expect(renameSyncFn.mock.calls[0] as unknown[]).toEqual([
      OLD_IMAGE,
      NEW_IMAGE,
    ]);
    expect(renameSyncFn.mock.calls[1] as unknown[]).toEqual([
      OLD_TRAITS,
      NEW_TRAITS,
    ]);
  });

  test("no-op when new files already exist", () => {
    setupExistsSync({
      [OLD_IMAGE]: true,
      [NEW_IMAGE]: true,
      [OLD_TRAITS]: true,
      [NEW_TRAITS]: true,
    });

    avatarRenameMigration.run(WORKSPACE_DIR);

    expect(renameSyncFn).not.toHaveBeenCalled();
  });

  test("no-op when no old files exist", () => {
    setupExistsSync({
      [OLD_IMAGE]: false,
      [NEW_IMAGE]: false,
      [OLD_TRAITS]: false,
      [NEW_TRAITS]: false,
    });

    avatarRenameMigration.run(WORKSPACE_DIR);

    expect(renameSyncFn).not.toHaveBeenCalled();
  });

  test("partial rename — only image exists", () => {
    setupExistsSync({
      [OLD_IMAGE]: true,
      [NEW_IMAGE]: false,
      [OLD_TRAITS]: false,
      [NEW_TRAITS]: false,
    });

    avatarRenameMigration.run(WORKSPACE_DIR);

    expect(renameSyncFn).toHaveBeenCalledTimes(1);
    expect(renameSyncFn.mock.calls[0] as unknown[]).toEqual([
      OLD_IMAGE,
      NEW_IMAGE,
    ]);
  });

  test("partial rename — only traits exist", () => {
    setupExistsSync({
      [OLD_IMAGE]: false,
      [NEW_IMAGE]: false,
      [OLD_TRAITS]: true,
      [NEW_TRAITS]: false,
    });

    avatarRenameMigration.run(WORKSPACE_DIR);

    expect(renameSyncFn).toHaveBeenCalledTimes(1);
    expect(renameSyncFn.mock.calls[0] as unknown[]).toEqual([
      OLD_TRAITS,
      NEW_TRAITS,
    ]);
  });
});
