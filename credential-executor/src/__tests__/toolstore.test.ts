import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  type SecureCommandManifest,
  MANIFEST_SCHEMA_VERSION,
  EgressMode,
} from "../commands/profiles.js";
import { AuthAdapterType } from "../commands/auth-adapters.js";
import { computeDigest, verifyDigest } from "../toolstore/integrity.js";
import {
  isValidSha256Hex,
  validateSourceUrl,
  isWorkspaceOriginPath,
} from "../toolstore/manifest.js";
import {
  publishBundle,
  readPublishedManifest,
  isBundlePublished,
  type PublishRequest,
} from "../toolstore/publish.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Create a tar.gz archive containing a shell script at the given entrypoint path.
 * Returns the archive bytes.
 */
function createTestArchive(
  entrypoint: string,
  scriptContent = "#!/usr/bin/env bash\necho hello\n",
): Buffer {
  const stagingDir = join(tmpdir(), `ces-test-archive-${randomUUID()}`);
  try {
    const entrypointPath = join(stagingDir, entrypoint);
    mkdirSync(join(stagingDir, entrypoint, ".."), { recursive: true });
    writeFileSync(entrypointPath, scriptContent, { mode: 0o755 });

    const archivePath = join(stagingDir, "bundle.tar.gz");
    const proc = Bun.spawnSync(
      ["tar", "czf", archivePath, "-C", stagingDir, entrypoint],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) {
      throw new Error(`Failed to create test archive: ${new TextDecoder().decode(proc.stderr).trim()}`);
    }
    return Buffer.from(readFileSync(archivePath));
  } finally {
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Sample bundle bytes as a valid tar.gz archive containing bin/test-cli. */
const SAMPLE_BUNDLE_BYTES = createTestArchive("bin/test-cli");

/** The correct SHA-256 digest of SAMPLE_BUNDLE_BYTES. */
const SAMPLE_BUNDLE_DIGEST = computeDigest(SAMPLE_BUNDLE_BYTES);

/** A different archive to test digest mismatches. */
const TAMPERED_BUNDLE_BYTES = createTestArchive("bin/test-cli", "#!/usr/bin/env bash\nrm -rf /\n");

/**
 * Build a minimal valid SecureCommandManifest for testing.
 */
function buildSecureManifest(
  overrides: Partial<SecureCommandManifest> = {},
): SecureCommandManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    bundleDigest: SAMPLE_BUNDLE_DIGEST,
    bundleId: "test-cli",
    version: "1.0.0",
    entrypoint: "bin/test-cli",
    commandProfiles: {
      "read-data": {
        description: "Read-only data access",
        allowedArgvPatterns: [
          { name: "list", tokens: ["list", "<resource>"] },
        ],
        deniedSubcommands: ["admin"],
        allowedNetworkTargets: [
          { hostPattern: "api.example.com", protocols: ["https"] },
        ],
      },
    },
    authAdapter: {
      type: AuthAdapterType.EnvVar,
      envVarName: "TEST_TOKEN",
    },
    egressMode: EgressMode.ProxyRequired,
    ...overrides,
  };
}

/**
 * Build a valid PublishRequest for testing.
 */
function buildPublishRequest(
  overrides: Partial<PublishRequest> = {},
): PublishRequest {
  return {
    bundleBytes: SAMPLE_BUNDLE_BYTES,
    expectedDigest: SAMPLE_BUNDLE_DIGEST,
    bundleId: "test-cli",
    version: "1.0.0",
    sourceUrl: "https://releases.example.com/test-cli/v1.0.0/bundle.tar.gz",
    secureCommandManifest: buildSecureManifest(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Temp directory management for publisher tests
// ---------------------------------------------------------------------------

let testTmpDir: string;

beforeEach(() => {
  testTmpDir = join(
    tmpdir(),
    `ces-toolstore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testTmpDir, { recursive: true });

  // Point CES data root to the temp directory so tests are isolated
  process.env["BASE_DATA_DIR"] = testTmpDir;
});

afterEach(() => {
  try {
    rmSync(testTmpDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
  delete process.env["BASE_DATA_DIR"];
});

// ---------------------------------------------------------------------------
// Integrity: computeDigest / verifyDigest
// ---------------------------------------------------------------------------

describe("integrity", () => {
  test("computeDigest returns a 64-character hex string", () => {
    const digest = computeDigest(SAMPLE_BUNDLE_BYTES);
    expect(digest).toHaveLength(64);
    expect(/^[a-f0-9]{64}$/.test(digest)).toBe(true);
  });

  test("computeDigest is deterministic", () => {
    const d1 = computeDigest(SAMPLE_BUNDLE_BYTES);
    const d2 = computeDigest(SAMPLE_BUNDLE_BYTES);
    expect(d1).toBe(d2);
  });

  test("computeDigest differs for different inputs", () => {
    const d1 = computeDigest(SAMPLE_BUNDLE_BYTES);
    const d2 = computeDigest(TAMPERED_BUNDLE_BYTES);
    expect(d1).not.toBe(d2);
  });

  test("verifyDigest succeeds when digest matches", () => {
    const result = verifyDigest(SAMPLE_BUNDLE_BYTES, SAMPLE_BUNDLE_DIGEST);
    expect(result.valid).toBe(true);
    expect(result.computedDigest).toBe(SAMPLE_BUNDLE_DIGEST);
    expect(result.expectedDigest).toBe(SAMPLE_BUNDLE_DIGEST);
    expect(result.error).toBeUndefined();
  });

  test("verifyDigest fails when digest does not match", () => {
    const wrongDigest = computeDigest(TAMPERED_BUNDLE_BYTES);
    const result = verifyDigest(SAMPLE_BUNDLE_BYTES, wrongDigest);
    expect(result.valid).toBe(false);
    expect(result.computedDigest).toBe(SAMPLE_BUNDLE_DIGEST);
    expect(result.expectedDigest).toBe(wrongDigest);
    expect(result.error).toContain("Digest mismatch");
  });

  test("verifyDigest fails for invalid hex digest", () => {
    const result = verifyDigest(SAMPLE_BUNDLE_BYTES, "not-a-valid-hex-digest");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Digest mismatch");
  });

  test("verifyDigest fails for truncated digest", () => {
    const truncated = SAMPLE_BUNDLE_DIGEST.slice(0, 32);
    const result = verifyDigest(SAMPLE_BUNDLE_BYTES, truncated);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Digest mismatch");
  });
});

// ---------------------------------------------------------------------------
// Manifest validation helpers
// ---------------------------------------------------------------------------

describe("manifest validation helpers", () => {
  describe("isValidSha256Hex", () => {
    test("accepts valid 64-char hex digest", () => {
      expect(isValidSha256Hex(SAMPLE_BUNDLE_DIGEST)).toBe(true);
    });

    test("accepts all-zero digest", () => {
      expect(isValidSha256Hex("0".repeat(64))).toBe(true);
    });

    test("rejects too-short digest", () => {
      expect(isValidSha256Hex("abc123")).toBe(false);
    });

    test("rejects too-long digest", () => {
      expect(isValidSha256Hex("a".repeat(65))).toBe(false);
    });

    test("rejects uppercase hex", () => {
      expect(isValidSha256Hex("A".repeat(64))).toBe(false);
    });

    test("rejects non-hex characters", () => {
      expect(isValidSha256Hex("g".repeat(64))).toBe(false);
    });

    test("rejects empty string", () => {
      expect(isValidSha256Hex("")).toBe(false);
    });
  });

  describe("validateSourceUrl", () => {
    test("accepts valid HTTPS URL", () => {
      expect(
        validateSourceUrl("https://releases.example.com/v1/bundle.tar.gz"),
      ).toBeNull();
    });

    test("rejects empty string", () => {
      const err = validateSourceUrl("");
      expect(err).not.toBeNull();
      expect(err).toContain("required");
    });

    test("rejects file:// URL", () => {
      const err = validateSourceUrl("file:///tmp/bundle.tar.gz");
      expect(err).not.toBeNull();
      expect(err).toContain("file:");
    });

    test("rejects data: URL", () => {
      const err = validateSourceUrl("data:application/octet-stream;base64,AA==");
      expect(err).not.toBeNull();
      expect(err).toContain("data:");
    });

    test("rejects HTTP URL (not HTTPS)", () => {
      const err = validateSourceUrl("http://example.com/bundle.tar.gz");
      expect(err).not.toBeNull();
      expect(err).toContain("HTTPS");
    });

    test("rejects non-URL string", () => {
      const err = validateSourceUrl("/usr/local/bin/my-tool");
      expect(err).not.toBeNull();
      expect(err).toContain("not a valid URL");
    });
  });

  describe("isWorkspaceOriginPath", () => {
    test("detects .vellum/ paths", () => {
      expect(isWorkspaceOriginPath("~/.vellum/workspace/tools/my-tool")).toBe(
        true,
      );
      expect(isWorkspaceOriginPath(".vellum/workspace/tools/my-tool")).toBe(
        true,
      );
      expect(
        isWorkspaceOriginPath("/home/user/.vellum/workspace/tools/my-tool"),
      ).toBe(true);
    });

    test("detects workspace paths", () => {
      expect(isWorkspaceOriginPath("/some/path/workspace/tools/my-tool")).toBe(
        true,
      );
    });

    test("allows non-workspace paths", () => {
      expect(isWorkspaceOriginPath("/usr/local/bin/gh")).toBe(false);
      expect(isWorkspaceOriginPath("/opt/tools/my-cli")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Publisher: digest mismatch rejection
// ---------------------------------------------------------------------------

describe("publishBundle — digest mismatch rejection", () => {
  test("rejects bundle whose bytes do not match expectedDigest", () => {
    const result = publishBundle(
      buildPublishRequest({
        bundleBytes: TAMPERED_BUNDLE_BYTES,
        // expectedDigest is for SAMPLE_BUNDLE_BYTES, not TAMPERED_BUNDLE_BYTES
        expectedDigest: SAMPLE_BUNDLE_DIGEST,
      }),
    );
    expect(result.success).toBe(false);
    expect(result.deduplicated).toBe(false);
    expect(result.error).toContain("Digest mismatch");
  });

  test("rejects bundle with invalid digest format", () => {
    const result = publishBundle(
      buildPublishRequest({
        expectedDigest: "not-a-valid-digest",
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid expectedDigest");
  });

  test("no files are written when digest mismatches", () => {
    publishBundle(
      buildPublishRequest({
        bundleBytes: TAMPERED_BUNDLE_BYTES,
        expectedDigest: SAMPLE_BUNDLE_DIGEST,
      }),
    );

    // The toolstore directory should not contain a directory for the expected digest
    const toolstoreDir = join(
      testTmpDir,
      ".vellum",
      "protected",
      "credential-executor",
      "toolstore",
    );
    const bundleDir = join(toolstoreDir, SAMPLE_BUNDLE_DIGEST);
    expect(existsSync(bundleDir)).toBe(false);

    // Also check that no staging directories were left behind
    if (existsSync(toolstoreDir)) {
      const { readdirSync } = require("node:fs");
      const entries = readdirSync(toolstoreDir) as string[];
      const stagingDirs = entries.filter((e: string) => e.startsWith(".staging-"));
      expect(stagingDirs).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Publisher: immutable and deduplicated
// ---------------------------------------------------------------------------

describe("publishBundle — immutable and deduplicated by digest", () => {
  test("first publish succeeds with deduplicated=false", () => {
    const result = publishBundle(buildPublishRequest());
    expect(result.success).toBe(true);
    expect(result.deduplicated).toBe(false);
    expect(result.bundlePath).toContain(SAMPLE_BUNDLE_DIGEST);
  });

  test("second publish of same digest returns deduplicated=true", () => {
    const first = publishBundle(buildPublishRequest());
    expect(first.success).toBe(true);
    expect(first.deduplicated).toBe(false);

    const second = publishBundle(buildPublishRequest());
    expect(second.success).toBe(true);
    expect(second.deduplicated).toBe(true);
    expect(second.bundlePath).toBe(first.bundlePath);
  });

  test("published bundle contains extracted entrypoint (not raw archive)", () => {
    const result = publishBundle(buildPublishRequest());
    expect(result.success).toBe(true);

    // After extraction, bundle.bin is removed and replaced by extracted contents
    const bundleContentPath = join(result.bundlePath, "bundle.bin");
    expect(existsSync(bundleContentPath)).toBe(false);

    // The entrypoint should exist and be executable
    const entrypointPath = join(result.bundlePath, "bin", "test-cli");
    expect(existsSync(entrypointPath)).toBe(true);

    const content = readFileSync(entrypointPath, "utf-8");
    expect(content).toContain("echo hello");
  });

  test("published manifest is readable and has correct fields", () => {
    publishBundle(buildPublishRequest());

    const manifest = readPublishedManifest(SAMPLE_BUNDLE_DIGEST);
    expect(manifest).not.toBeNull();
    expect(manifest!.digest).toBe(SAMPLE_BUNDLE_DIGEST);
    expect(manifest!.bundleId).toBe("test-cli");
    expect(manifest!.version).toBe("1.0.0");
    expect(manifest!.origin.sourceUrl).toBe(
      "https://releases.example.com/test-cli/v1.0.0/bundle.tar.gz",
    );
    expect(manifest!.declaredProfiles).toEqual(["read-data"]);
    expect(manifest!.publishedAt).toBeTruthy();
  });

  test("isBundlePublished returns false before publish", () => {
    expect(isBundlePublished(SAMPLE_BUNDLE_DIGEST)).toBe(false);
  });

  test("isBundlePublished returns true after publish", () => {
    publishBundle(buildPublishRequest());
    expect(isBundlePublished(SAMPLE_BUNDLE_DIGEST)).toBe(true);
  });

  test("different bundles with different digests are stored independently", () => {
    // Publish first bundle
    const firstResult = publishBundle(buildPublishRequest());
    expect(firstResult.success).toBe(true);

    // Publish a second, different bundle (real tar.gz archive)
    const otherBytes = createTestArchive("bin/test-cli", "#!/usr/bin/env bash\necho other\n");
    const otherDigest = computeDigest(otherBytes);
    const otherManifest = buildSecureManifest({
      bundleDigest: otherDigest,
      bundleId: "other-cli",
      version: "2.0.0",
    });

    const secondResult = publishBundle(
      buildPublishRequest({
        bundleBytes: otherBytes,
        expectedDigest: otherDigest,
        bundleId: "other-cli",
        version: "2.0.0",
        sourceUrl: "https://releases.example.com/other-cli/v2.0.0/bundle.tar.gz",
        secureCommandManifest: otherManifest,
      }),
    );
    expect(secondResult.success).toBe(true);
    expect(secondResult.deduplicated).toBe(false);
    expect(secondResult.bundlePath).not.toBe(firstResult.bundlePath);

    // Both are independently published
    expect(isBundlePublished(SAMPLE_BUNDLE_DIGEST)).toBe(true);
    expect(isBundlePublished(otherDigest)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Publisher: publication does not imply credential grant
// ---------------------------------------------------------------------------

describe("publishBundle — publication does not imply credential grant", () => {
  test("publish result does not contain any grant or credential fields", () => {
    const result = publishBundle(buildPublishRequest());
    expect(result.success).toBe(true);

    // The PublishResult type only has success, deduplicated, bundlePath, error.
    // There are no grant-related fields.
    const keys = Object.keys(result);
    expect(keys).not.toContain("grant");
    expect(keys).not.toContain("credential");
    expect(keys).not.toContain("token");
    expect(keys).not.toContain("secret");
  });

  test("toolstore manifest does not contain grant or credential data", () => {
    publishBundle(buildPublishRequest());

    const manifest = readPublishedManifest(SAMPLE_BUNDLE_DIGEST);
    expect(manifest).not.toBeNull();

    // Verify the manifest only contains content metadata, not grants
    const keys = Object.keys(manifest!);
    expect(keys).not.toContain("grant");
    expect(keys).not.toContain("credential");
    expect(keys).not.toContain("token");
    expect(keys).not.toContain("secret");
    expect(keys).toContain("digest");
    expect(keys).toContain("bundleId");
    expect(keys).toContain("origin");
    expect(keys).toContain("declaredProfiles");
  });
});

// ---------------------------------------------------------------------------
// Publisher: source URL validation
// ---------------------------------------------------------------------------

describe("publishBundle — source URL validation", () => {
  test("rejects file:// source URL", () => {
    const result = publishBundle(
      buildPublishRequest({
        sourceUrl: "file:///tmp/bundle.tar.gz",
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("file:");
  });

  test("rejects HTTP source URL", () => {
    const result = publishBundle(
      buildPublishRequest({
        sourceUrl: "http://insecure.example.com/bundle.tar.gz",
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTPS");
  });

  test("rejects workspace-origin source URL", () => {
    const result = publishBundle(
      buildPublishRequest({
        sourceUrl: "https://example.com/.vellum/workspace/tools/bundle.tar.gz",
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("workspace-origin");
  });

  test("rejects empty source URL", () => {
    const result = publishBundle(
      buildPublishRequest({
        sourceUrl: "",
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("required");
  });
});

// ---------------------------------------------------------------------------
// Publisher: manifest validation pass-through
// ---------------------------------------------------------------------------

describe("publishBundle — manifest validation", () => {
  test("rejects bundle with invalid secure command manifest", () => {
    const invalidManifest = buildSecureManifest({
      entrypoint: "/bin/bash", // denied binary
    });

    const result = publishBundle(
      buildPublishRequest({
        secureCommandManifest: invalidManifest,
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid secure command manifest");
    expect(result.error).toContain("bash");
  });

  test("rejects bundle with empty command profiles", () => {
    const invalidManifest = buildSecureManifest({
      commandProfiles: {},
    });

    const result = publishBundle(
      buildPublishRequest({
        secureCommandManifest: invalidManifest,
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid secure command manifest");
  });
});
