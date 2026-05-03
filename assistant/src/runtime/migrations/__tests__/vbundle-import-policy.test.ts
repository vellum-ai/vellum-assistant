/**
 * Unit tests for the pure policy module shared by both vbundle importers.
 *
 * No `node:fs`, no temp dirs — every test exercises a constant or a
 * predicate over strings.
 */

import { describe, expect, test } from "bun:test";

import {
  compareSemver,
  CONFIG_ARCHIVE_PATHS,
  CREDENTIAL_METADATA_ARCHIVE_PATH,
  evaluateRuntimeCompatibility,
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

describe("compareSemver", () => {
  test("0.10.0 > 0.9.0 (numeric, not lexical)", () => {
    expect(compareSemver("0.10.0", "0.9.0")).toBe(1);
  });

  test("equal triples return 0", () => {
    expect(compareSemver("0.7.1", "0.7.1")).toBe(0);
  });

  test("smaller patch returns -1", () => {
    expect(compareSemver("0.7.0", "0.7.1")).toBe(-1);
  });

  test("prerelease tag is stripped (treated as base release)", () => {
    expect(compareSemver("0.7.1-staging.1", "0.7.1")).toBe(0);
  });

  test("non-version string returns null", () => {
    expect(compareSemver("not-a-version", "0.7.1")).toBe(null);
  });

  test("two-part version returns null", () => {
    expect(compareSemver("1.2", "0.7.1")).toBe(null);
  });

  // Regression: Number.parseInt accepts numeric prefixes and ignores
  // trailing junk ("0foo" → 0), which previously coerced malformed
  // triples through the gate. parseSemverTriple now requires each
  // component to match /^\d+$/ exactly.
  test("trailing junk on a component returns null (left arg)", () => {
    expect(compareSemver("0.8.0foo", "0.8.0")).toBe(null);
  });

  test("trailing junk on a component returns null (right arg)", () => {
    expect(compareSemver("0.8.0", "0.7.1xyz")).toBe(null);
  });

  // Leading zeros are accepted: "01.02.03" parses to the same numeric
  // triple as "1.2.3" since Number("01") === 1. We pin this behavior
  // so a future tightening doesn't accidentally regress callers that
  // pass zero-padded versions from upstream tooling.
  test("leading zeros parse equal to un-padded triple", () => {
    expect(compareSemver("01.02.03", "1.2.3")).toBe(0);
  });

  test("leading whitespace returns null", () => {
    expect(compareSemver(" 0.8.0", "0.8.0")).toBe(null);
  });

  test("negative component returns null", () => {
    expect(compareSemver("0.8.-1", "0.8.0")).toBe(null);
  });
});

describe("evaluateRuntimeCompatibility", () => {
  test("legacy sentinel passes regardless of runtime version", () => {
    expect(
      evaluateRuntimeCompatibility(
        { min_runtime_version: "0.0.0-legacy", max_runtime_version: null },
        "0.7.1",
      ),
    ).toEqual({ ok: true });
  });

  test("runtime above min with no max passes", () => {
    expect(
      evaluateRuntimeCompatibility(
        { min_runtime_version: "0.7.0", max_runtime_version: null },
        "0.7.1",
      ),
    ).toEqual({ ok: true });
  });

  test("runtime below min fails with full echo", () => {
    const compat = {
      min_runtime_version: "0.8.0",
      max_runtime_version: null,
    };
    expect(evaluateRuntimeCompatibility(compat, "0.7.1")).toEqual({
      ok: false,
      reason: "version_incompatible",
      bundle_compat: compat,
      runtime_version: "0.7.1",
    });
  });

  test("runtime above max fails", () => {
    const compat = {
      min_runtime_version: "0.7.0",
      max_runtime_version: "0.7.5",
    };
    expect(evaluateRuntimeCompatibility(compat, "0.8.0")).toEqual({
      ok: false,
      reason: "version_incompatible",
      bundle_compat: compat,
      runtime_version: "0.8.0",
    });
  });

  test("max is inclusive", () => {
    expect(
      evaluateRuntimeCompatibility(
        { min_runtime_version: "0.7.0", max_runtime_version: "0.7.5" },
        "0.7.5",
      ),
    ).toEqual({ ok: true });
  });

  test("unparsable min skips the gate (fail-open)", () => {
    expect(
      evaluateRuntimeCompatibility(
        { min_runtime_version: "garbage", max_runtime_version: null },
        "0.7.1",
      ),
    ).toEqual({ ok: true });
  });

  // Regression for Codex feedback: a malformed min like "0.8.0foo"
  // previously coerced to [0, 8, 0] via Number.parseInt and incorrectly
  // produced a version_incompatible decision against runtime "0.7.1".
  // With strict per-component digit matching, the parse fails and the
  // gate fails open.
  test("malformed min with trailing junk fails open, does not block", () => {
    expect(
      evaluateRuntimeCompatibility(
        { min_runtime_version: "0.8.0foo", max_runtime_version: null },
        "0.7.1",
      ),
    ).toEqual({ ok: true });
  });
});
