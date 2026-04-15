import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// realpathSync resolves the macOS /var → /private/var symlink so the paths
// match what resolveAllowedFileBackedAttachmentPath returns (it canonicalizes
// via realpathSync internally).
const testWorkspaceDir = realpathSync(
  mkdtempSync(join(tmpdir(), "attachment-routes-workspace-")),
);
const testHomeDir = realpathSync(
  mkdtempSync(join(tmpdir(), "attachment-routes-home-")),
);

const attachmentsDir = join(testWorkspaceDir, "data", "attachments");
const conversationsDir = join(testWorkspaceDir, "conversations");
const recordingsDir = join(
  testHomeDir,
  "Library/Application Support/vellum-assistant/recordings",
);
const outsideDir = mkdtempSync(join(tmpdir(), "attachment-routes-outside-"));

const originalHome = process.env.HOME;
process.env.HOME = testHomeDir;

mock.module("../../util/platform.js", () => ({
  getWorkspaceDir: () => testWorkspaceDir,
}));

import { resolveAllowedFileBackedAttachmentPath } from "./attachment-routes.js";

beforeAll(() => {
  mkdirSync(attachmentsDir, { recursive: true });
  mkdirSync(conversationsDir, { recursive: true });
  mkdirSync(recordingsDir, { recursive: true });
});

afterAll(() => {
  process.env.HOME = originalHome;
  rmSync(testWorkspaceDir, { recursive: true, force: true });
  rmSync(testHomeDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe("resolveAllowedFileBackedAttachmentPath", () => {
  test("allows files in workspace attachments directory", () => {
    const attachmentFile = join(attachmentsDir, "sample.txt");
    writeFileSync(attachmentFile, "ok");

    expect(resolveAllowedFileBackedAttachmentPath(attachmentFile)).toBe(
      attachmentFile,
    );
  });

  test("allows files in recordings directory", () => {
    const recordingFile = join(recordingsDir, "recording.mov");
    writeFileSync(recordingFile, "ok");

    expect(resolveAllowedFileBackedAttachmentPath(recordingFile)).toBe(
      recordingFile,
    );
  });

  test("allows files in conversation attachments directory", () => {
    const convAttachDir = join(conversationsDir, "conv-123", "attachments");
    mkdirSync(convAttachDir, { recursive: true });
    const convFile = join(convAttachDir, "photo.jpg");
    writeFileSync(convFile, "ok");

    expect(resolveAllowedFileBackedAttachmentPath(convFile)).toBe(convFile);
  });

  test("rejects files in conversation dir outside attachments subdir", () => {
    const convDir = join(conversationsDir, "conv-456");
    mkdirSync(convDir, { recursive: true });
    const metaFile = join(convDir, "meta.json");
    writeFileSync(metaFile, "{}");

    expect(resolveAllowedFileBackedAttachmentPath(metaFile)).toBeNull();
  });

  test("rejects files outside allowed directories", () => {
    const outsideFile = join(outsideDir, "secret.txt");
    writeFileSync(outsideFile, "secret");

    expect(resolveAllowedFileBackedAttachmentPath(outsideFile)).toBeNull();
  });

  test("rejects path traversal via '..' segments", () => {
    const traversalPath = join(attachmentsDir, "..", "..", "secret.txt");

    expect(resolveAllowedFileBackedAttachmentPath(traversalPath)).toBeNull();
  });

  test("rejects symlinks inside allowed dir pointing outside", () => {
    const outsideFile = join(outsideDir, "linked-secret.txt");
    writeFileSync(outsideFile, "secret");

    const symlinkPath = join(attachmentsDir, "sneaky-link.txt");
    symlinkSync(outsideFile, symlinkPath);

    expect(resolveAllowedFileBackedAttachmentPath(symlinkPath)).toBeNull();
  });
});
