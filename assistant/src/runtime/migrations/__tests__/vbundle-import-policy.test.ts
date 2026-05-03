/**
 * Unit tests for the pure policy module shared by both vbundle importers.
 *
 * No `node:fs`, no temp dirs — every test exercises a constant or a
 * predicate over strings.
 */

import { describe, expect, test } from "bun:test";

import {
  CONFIG_ARCHIVE_PATHS,
  CREDENTIAL_METADATA_ARCHIVE_PATH,
  isConfigArchivePath,
  isCredentialMetadataArchivePath,
  isLegacyPersonaArchivePath,
  isWorkspaceNamespacedArchivePath,
  LEGACY_USER_MD_ARCHIVE_PATH,
  partitionWorkspacePreserveSkipDirs,
  WORKSPACE_PRESERVE_PATHS,
} from "../vbundle-import-policy.js";

describe("LEGACY_USER_MD_ARCHIVE_PATH", () => {
  test("equals the legacy guardian persona archive path", () => {
    expect(LEGACY_USER_MD_ARCHIVE_PATH).toBe("prompts/USER.md");
  });
});

describe("CONFIG_ARCHIVE_PATHS", () => {
  test("contains exactly the two known config archive paths", () => {
    expect(CONFIG_ARCHIVE_PATHS.size).toBe(2);
    expect(CONFIG_ARCHIVE_PATHS.has("workspace/config.json")).toBe(true);
    expect(CONFIG_ARCHIVE_PATHS.has("config/settings.json")).toBe(true);
  });
});

describe("CREDENTIAL_METADATA_ARCHIVE_PATH", () => {
  test("equals the workspace-namespaced credential metadata path", () => {
    expect(CREDENTIAL_METADATA_ARCHIVE_PATH).toBe(
      "workspace/data/credentials/metadata.json",
    );
  });
});

describe("WORKSPACE_PRESERVE_PATHS", () => {
  test("matches the literal 4-element ordered list", () => {
    expect(WORKSPACE_PRESERVE_PATHS).toEqual([
      "embedding-models",
      "deprecated",
      "data/db",
      "data/qdrant",
    ]);
  });
});

describe("isWorkspaceNamespacedArchivePath", () => {
  test("true for paths under workspace/", () => {
    expect(isWorkspaceNamespacedArchivePath("workspace/foo")).toBe(true);
    expect(isWorkspaceNamespacedArchivePath("workspace/data/db/x")).toBe(true);
  });

  test("false for non-workspace paths", () => {
    expect(isWorkspaceNamespacedArchivePath("prompts/USER.md")).toBe(false);
    expect(isWorkspaceNamespacedArchivePath("data/db/assistant.db")).toBe(
      false,
    );
    expect(isWorkspaceNamespacedArchivePath("")).toBe(false);
    expect(isWorkspaceNamespacedArchivePath("workspace")).toBe(false);
  });
});

describe("isLegacyPersonaArchivePath", () => {
  test("true only for the exact legacy path", () => {
    expect(isLegacyPersonaArchivePath("prompts/USER.md")).toBe(true);
  });

  test("false for near-misses and unrelated paths", () => {
    expect(isLegacyPersonaArchivePath("prompts/USER")).toBe(false);
    expect(isLegacyPersonaArchivePath("workspace/prompts/USER.md")).toBe(false);
    expect(isLegacyPersonaArchivePath("")).toBe(false);
  });
});

describe("isConfigArchivePath", () => {
  test("true for both members of CONFIG_ARCHIVE_PATHS", () => {
    expect(isConfigArchivePath("workspace/config.json")).toBe(true);
    expect(isConfigArchivePath("config/settings.json")).toBe(true);
  });

  test("false for non-members", () => {
    expect(isConfigArchivePath("workspace/foo.json")).toBe(false);
    expect(isConfigArchivePath("config/settings")).toBe(false);
    expect(isConfigArchivePath("")).toBe(false);
  });
});

describe("isCredentialMetadataArchivePath", () => {
  test("true for the exact constant", () => {
    expect(
      isCredentialMetadataArchivePath(
        "workspace/data/credentials/metadata.json",
      ),
    ).toBe(true);
  });

  test("false for the legacy non-prefixed form and empty string", () => {
    expect(
      isCredentialMetadataArchivePath("data/credentials/metadata.json"),
    ).toBe(false);
    expect(isCredentialMetadataArchivePath("")).toBe(false);
  });
});

describe("partitionWorkspacePreserveSkipDirs", () => {
  test("splits preserve-paths into top-level vs data-subdir skip sets", () => {
    const { topLevelSkipDirs, dataSubdirSkipDirs } =
      partitionWorkspacePreserveSkipDirs();

    expect(topLevelSkipDirs.size).toBe(2);
    expect(topLevelSkipDirs.has("embedding-models")).toBe(true);
    expect(topLevelSkipDirs.has("deprecated")).toBe(true);

    expect(dataSubdirSkipDirs.size).toBe(2);
    expect(dataSubdirSkipDirs.has("db")).toBe(true);
    expect(dataSubdirSkipDirs.has("qdrant")).toBe(true);
  });
});
