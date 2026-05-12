/**
 * Tests for workspace migration `080-restrict-vercel-api-token-metadata`.
 *
 * The migration rewrites Vercel API token credential metadata from
 * the legacy vulnerable policy (bash in allowedTools, injection
 * templates) to the hardened policy (publish_page + unpublish_page
 * only, no injection templates).
 *
 * Cases covered:
 *   1. Legacy vulnerable metadata -> repaired to target policy.
 *   2. Already-migrated metadata -> no-op (file unchanged).
 *   3. Missing metadata file -> no-op (no error).
 *   4. Malformed JSON -> no-op (no error).
 *   5. Unrelated credentials preserved during repair.
 *   6. Unrecognized future schema version -> no-op.
 *   7. No Vercel record present -> no-op.
 *   8. Idempotent: second run on repaired file is a no-op.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { restrictVercelApiTokenMetadataMigration } from "../workspace/migrations/080-restrict-vercel-api-token-metadata.js";

let workspaceDir: string;
let metadataPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-080-test-"));
  metadataPath = join(workspaceDir, "data", "credentials", "metadata.json");
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function writeMetadata(contents: unknown): void {
  mkdirSync(join(workspaceDir, "data", "credentials"), { recursive: true });
  writeFileSync(metadataPath, JSON.stringify(contents, null, 2), "utf-8");
}

function readMetadata(): Record<string, unknown> {
  return JSON.parse(readFileSync(metadataPath, "utf-8"));
}

/** The legacy vulnerable Vercel credential record (pre-PR 2). */
function makeLegacyVercelRecord(
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    credentialId: "cred-vercel-123",
    service: "vercel",
    field: "api_token",
    allowedTools: ["deploy", "publish_page", "bash"],
    allowedDomains: [],
    injectionTemplates: [
      {
        hostPattern: "api.vercel.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

/** The expected hardened Vercel credential record (post-migration). */
function makeHardenedVercelRecord(
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    credentialId: "cred-vercel-123",
    service: "vercel",
    field: "api_token",
    allowedTools: ["publish_page", "unpublish_page"],
    allowedDomains: [],
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

/** An unrelated credential record (should never be touched). */
function makeOtherRecord(): Record<string, unknown> {
  return {
    credentialId: "cred-other-456",
    service: "slack",
    field: "bot_token",
    allowedTools: ["send_message"],
    allowedDomains: ["slack.com"],
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };
}

describe("workspace migration 080-restrict-vercel-api-token-metadata", () => {
  test("has the expected id and description", () => {
    expect(restrictVercelApiTokenMetadataMigration.id).toBe(
      "080-restrict-vercel-api-token-metadata",
    );
    expect(restrictVercelApiTokenMetadataMigration.description).toContain(
      "Vercel",
    );
  });

  test("repairs legacy vulnerable metadata to hardened policy", () => {
    writeMetadata({
      version: 5,
      credentials: [makeLegacyVercelRecord()],
    });

    restrictVercelApiTokenMetadataMigration.run(workspaceDir);

    const result = readMetadata();
    expect(result.version).toBe(5);
    const creds = result.credentials as Record<string, unknown>[];
    expect(creds).toHaveLength(1);

    const vercel = creds[0];
    expect(vercel.service).toBe("vercel");
    expect(vercel.field).toBe("api_token");
    expect(vercel.allowedTools).toEqual(["publish_page", "unpublish_page"]);
    expect(vercel.allowedDomains).toEqual([]);
    expect(vercel.injectionTemplates).toBeUndefined();
    // updatedAt should have been bumped.
    expect(vercel.updatedAt).not.toBe(1700000000000);
    // createdAt should be preserved.
    expect(vercel.createdAt).toBe(1700000000000);
    // credentialId should be preserved.
    expect(vercel.credentialId).toBe("cred-vercel-123");
  });

  test("already-migrated metadata is a no-op (file unchanged)", () => {
    writeMetadata({
      version: 5,
      credentials: [makeHardenedVercelRecord()],
    });
    const before = readFileSync(metadataPath, "utf-8");
    const beforeStat = statSync(metadataPath);

    restrictVercelApiTokenMetadataMigration.run(workspaceDir);

    const after = readFileSync(metadataPath, "utf-8");
    expect(after).toBe(before);
    expect(statSync(metadataPath).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  test("missing metadata file is a no-op (no error, no file created)", () => {
    expect(existsSync(metadataPath)).toBe(false);

    expect(() =>
      restrictVercelApiTokenMetadataMigration.run(workspaceDir),
    ).not.toThrow();

    expect(existsSync(metadataPath)).toBe(false);
  });

  test("malformed JSON is a no-op (does not throw, leaves file alone)", () => {
    mkdirSync(join(workspaceDir, "data", "credentials"), { recursive: true });
    writeFileSync(metadataPath, "{not valid json", "utf-8");
    const before = readFileSync(metadataPath, "utf-8");

    expect(() =>
      restrictVercelApiTokenMetadataMigration.run(workspaceDir),
    ).not.toThrow();

    expect(readFileSync(metadataPath, "utf-8")).toBe(before);
  });

  test("non-Vercel credentials are preserved unchanged during repair", () => {
    const other = makeOtherRecord();
    writeMetadata({
      version: 5,
      credentials: [other, makeLegacyVercelRecord()],
    });

    restrictVercelApiTokenMetadataMigration.run(workspaceDir);

    const result = readMetadata();
    const creds = result.credentials as Record<string, unknown>[];
    expect(creds).toHaveLength(2);

    // Other credential should be exactly unchanged.
    const otherCred = creds.find((c) => c.service === "slack");
    expect(otherCred).toBeDefined();
    expect(otherCred!.allowedTools).toEqual(["send_message"]);
    expect(otherCred!.allowedDomains).toEqual(["slack.com"]);
    expect(otherCred!.updatedAt).toBe(1700000000000);

    // Vercel credential should be repaired.
    const vercelCred = creds.find((c) => c.service === "vercel");
    expect(vercelCred).toBeDefined();
    expect(vercelCred!.allowedTools).toEqual([
      "publish_page",
      "unpublish_page",
    ]);
    expect(vercelCred!.injectionTemplates).toBeUndefined();
  });

  test("unrecognized future schema version is a no-op", () => {
    writeMetadata({
      version: 99,
      credentials: [makeLegacyVercelRecord()],
    });
    const before = readFileSync(metadataPath, "utf-8");

    expect(() =>
      restrictVercelApiTokenMetadataMigration.run(workspaceDir),
    ).not.toThrow();

    expect(readFileSync(metadataPath, "utf-8")).toBe(before);
  });

  test("no Vercel record present is a no-op", () => {
    writeMetadata({
      version: 5,
      credentials: [makeOtherRecord()],
    });
    const before = readFileSync(metadataPath, "utf-8");

    expect(() =>
      restrictVercelApiTokenMetadataMigration.run(workspaceDir),
    ).not.toThrow();

    expect(readFileSync(metadataPath, "utf-8")).toBe(before);
  });

  test("idempotent: second run on repaired file is a no-op", () => {
    writeMetadata({
      version: 5,
      credentials: [makeLegacyVercelRecord()],
    });

    restrictVercelApiTokenMetadataMigration.run(workspaceDir);
    const afterFirst = readFileSync(metadataPath, "utf-8");
    const afterFirstStat = statSync(metadataPath);

    restrictVercelApiTokenMetadataMigration.run(workspaceDir);
    const afterSecond = readFileSync(metadataPath, "utf-8");

    expect(afterSecond).toBe(afterFirst);
    expect(statSync(metadataPath).mtimeMs).toBe(afterFirstStat.mtimeMs);
  });

  test("non-object root is a no-op", () => {
    writeMetadata([1, 2, 3]);
    const before = readFileSync(metadataPath, "utf-8");

    expect(() =>
      restrictVercelApiTokenMetadataMigration.run(workspaceDir),
    ).not.toThrow();

    expect(readFileSync(metadataPath, "utf-8")).toBe(before);
  });

  test("file with no version field defaults to version 1 and processes", () => {
    writeMetadata({
      credentials: [makeLegacyVercelRecord()],
    });

    restrictVercelApiTokenMetadataMigration.run(workspaceDir);

    const result = readMetadata();
    const creds = result.credentials as Record<string, unknown>[];
    const vercel = creds.find((c) => c.service === "vercel");
    expect(vercel!.allowedTools).toEqual(["publish_page", "unpublish_page"]);
    expect(vercel!.injectionTemplates).toBeUndefined();
  });

  test("down() is a no-op (security hardening cannot be reversed)", () => {
    writeMetadata({
      version: 5,
      credentials: [makeLegacyVercelRecord()],
    });
    restrictVercelApiTokenMetadataMigration.run(workspaceDir);
    const after = readFileSync(metadataPath, "utf-8");

    expect(() =>
      restrictVercelApiTokenMetadataMigration.down(workspaceDir),
    ).not.toThrow();

    expect(readFileSync(metadataPath, "utf-8")).toBe(after);
  });
});
