/**
 * Tests for workspace migration `081-backfill-bash-allowed-tools-for-injection-credentials`.
 *
 * After migration 080 hardened the Vercel credential (removing its
 * injectionTemplates and setting allowedTools to publish tools only),
 * the shell.ts policy enforcement rejects proxied bash for every OTHER
 * service whose allowedTools was never populated. This migration
 * backfills `"bash"` into allowedTools for credentials that have
 * non-empty injectionTemplates and empty/missing allowedTools.
 *
 * Cases covered:
 *   1. Credential with injectionTemplates and empty allowedTools gets ["bash"] added.
 *   2. Credential with injectionTemplates and existing populated allowedTools is NOT modified.
 *   3. Credential without injectionTemplates is NOT modified.
 *   4. Vercel credential (no injectionTemplates after migration 080) is NOT modified.
 *   5. Missing metadata file -> no-op.
 *   6. Malformed JSON -> no-op.
 *   7. Idempotent: second run is a no-op.
 *   8. Multiple qualifying credentials are all backfilled.
 *   9. Unrecognized future schema version -> no-op.
 *  10. Non-object root -> no-op.
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

import { backfillBashAllowedToolsForInjectionCredentialsMigration } from "../workspace/migrations/081-backfill-bash-allowed-tools-for-injection-credentials.js";

let workspaceDir: string;
let metadataPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-081-test-"));
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

/** A credential with injectionTemplates and empty allowedTools (needs backfill). */
function makeSentryCredential(
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    credentialId: "cred-sentry-123",
    service: "sentry",
    field: "auth_token",
    allowedTools: [],
    allowedDomains: [],
    injectionTemplates: [
      {
        hostPattern: "sentry.io",
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

/** A credential with injectionTemplates and missing allowedTools (needs backfill). */
function makeResendCredential(): Record<string, unknown> {
  return {
    credentialId: "cred-resend-456",
    service: "resend",
    field: "api_key",
    allowedDomains: [],
    injectionTemplates: [
      {
        hostPattern: "api.resend.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Bearer ",
      },
    ],
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };
}

/** The Vercel credential after migration 080 (no injectionTemplates, populated allowedTools). */
function makeHardenedVercelCredential(): Record<string, unknown> {
  return {
    credentialId: "cred-vercel-789",
    service: "vercel",
    field: "api_token",
    allowedTools: ["publish_page", "unpublish_page"],
    allowedDomains: [],
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };
}

/** A credential with populated allowedTools AND injectionTemplates (should NOT be modified). */
function makeCredentialWithPopulatedAllowedTools(): Record<string, unknown> {
  return {
    credentialId: "cred-custom-101",
    service: "custom_service",
    field: "token",
    allowedTools: ["custom_tool_a", "custom_tool_b"],
    allowedDomains: [],
    injectionTemplates: [
      {
        hostPattern: "custom.example.com",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Token ",
      },
    ],
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };
}

/** A credential with no injectionTemplates (should NOT be modified). */
function makeCredentialWithoutInjectionTemplates(): Record<string, unknown> {
  return {
    credentialId: "cred-slack-202",
    service: "slack",
    field: "bot_token",
    allowedTools: [],
    allowedDomains: ["slack.com"],
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };
}

describe("workspace migration 081-backfill-bash-allowed-tools-for-injection-credentials", () => {
  test("has the expected id and description", () => {
    expect(backfillBashAllowedToolsForInjectionCredentialsMigration.id).toBe(
      "081-backfill-bash-allowed-tools-for-injection-credentials",
    );
    expect(
      backfillBashAllowedToolsForInjectionCredentialsMigration.description,
    ).toContain("bash");
  });

  test("credential with injectionTemplates and empty allowedTools gets bash added", () => {
    writeMetadata({
      version: 5,
      credentials: [makeSentryCredential()],
    });

    backfillBashAllowedToolsForInjectionCredentialsMigration.run(workspaceDir);

    const result = readMetadata();
    const creds = result.credentials as Record<string, unknown>[];
    expect(creds).toHaveLength(1);

    const sentry = creds[0];
    expect(sentry.service).toBe("sentry");
    expect(sentry.allowedTools).toEqual(["bash"]);
    // injectionTemplates should be preserved (not removed).
    expect(sentry.injectionTemplates).toBeDefined();
    expect((sentry.injectionTemplates as unknown[]).length).toBeGreaterThan(0);
    // updatedAt should have been bumped.
    expect(sentry.updatedAt).not.toBe(1700000000000);
    // createdAt should be preserved.
    expect(sentry.createdAt).toBe(1700000000000);
  });

  test("credential with injectionTemplates and missing allowedTools gets bash added", () => {
    writeMetadata({
      version: 5,
      credentials: [makeResendCredential()],
    });

    backfillBashAllowedToolsForInjectionCredentialsMigration.run(workspaceDir);

    const result = readMetadata();
    const creds = result.credentials as Record<string, unknown>[];
    const resend = creds[0];
    expect(resend.service).toBe("resend");
    expect(resend.allowedTools).toEqual(["bash"]);
  });

  test("credential with injectionTemplates and existing populated allowedTools is NOT modified", () => {
    const original = makeCredentialWithPopulatedAllowedTools();
    writeMetadata({
      version: 5,
      credentials: [original],
    });
    const before = readFileSync(metadataPath, "utf-8");

    backfillBashAllowedToolsForInjectionCredentialsMigration.run(workspaceDir);

    const after = readFileSync(metadataPath, "utf-8");
    expect(after).toBe(before);
  });

  test("credential without injectionTemplates is NOT modified", () => {
    writeMetadata({
      version: 5,
      credentials: [makeCredentialWithoutInjectionTemplates()],
    });
    const before = readFileSync(metadataPath, "utf-8");

    backfillBashAllowedToolsForInjectionCredentialsMigration.run(workspaceDir);

    const after = readFileSync(metadataPath, "utf-8");
    expect(after).toBe(before);
  });

  test("Vercel credential (no injectionTemplates after migration 080) is NOT modified", () => {
    writeMetadata({
      version: 5,
      credentials: [makeHardenedVercelCredential()],
    });
    const before = readFileSync(metadataPath, "utf-8");

    backfillBashAllowedToolsForInjectionCredentialsMigration.run(workspaceDir);

    const after = readFileSync(metadataPath, "utf-8");
    expect(after).toBe(before);
  });

  test("missing metadata file is a no-op (no error, no file created)", () => {
    expect(existsSync(metadataPath)).toBe(false);

    expect(() =>
      backfillBashAllowedToolsForInjectionCredentialsMigration.run(
        workspaceDir,
      ),
    ).not.toThrow();

    expect(existsSync(metadataPath)).toBe(false);
  });

  test("malformed JSON is a no-op (does not throw, leaves file alone)", () => {
    mkdirSync(join(workspaceDir, "data", "credentials"), { recursive: true });
    writeFileSync(metadataPath, "{not valid json", "utf-8");
    const before = readFileSync(metadataPath, "utf-8");

    expect(() =>
      backfillBashAllowedToolsForInjectionCredentialsMigration.run(
        workspaceDir,
      ),
    ).not.toThrow();

    expect(readFileSync(metadataPath, "utf-8")).toBe(before);
  });

  test("idempotent: second run on backfilled file is a no-op", () => {
    writeMetadata({
      version: 5,
      credentials: [makeSentryCredential()],
    });

    backfillBashAllowedToolsForInjectionCredentialsMigration.run(workspaceDir);
    const afterFirst = readFileSync(metadataPath, "utf-8");
    const afterFirstStat = statSync(metadataPath);

    backfillBashAllowedToolsForInjectionCredentialsMigration.run(workspaceDir);
    const afterSecond = readFileSync(metadataPath, "utf-8");

    expect(afterSecond).toBe(afterFirst);
    expect(statSync(metadataPath).mtimeMs).toBe(afterFirstStat.mtimeMs);
  });

  test("multiple qualifying credentials are all backfilled", () => {
    writeMetadata({
      version: 5,
      credentials: [
        makeSentryCredential(),
        makeResendCredential(),
        makeHardenedVercelCredential(),
        makeCredentialWithPopulatedAllowedTools(),
        makeCredentialWithoutInjectionTemplates(),
      ],
    });

    backfillBashAllowedToolsForInjectionCredentialsMigration.run(workspaceDir);

    const result = readMetadata();
    const creds = result.credentials as Record<string, unknown>[];
    expect(creds).toHaveLength(5);

    // Sentry: should be backfilled.
    const sentry = creds.find((c) => c.service === "sentry");
    expect(sentry!.allowedTools).toEqual(["bash"]);
    expect(sentry!.updatedAt).not.toBe(1700000000000);

    // Resend: should be backfilled.
    const resend = creds.find((c) => c.service === "resend");
    expect(resend!.allowedTools).toEqual(["bash"]);
    expect(resend!.updatedAt).not.toBe(1700000000000);

    // Vercel: NOT modified (no injectionTemplates, populated allowedTools).
    const vercel = creds.find((c) => c.service === "vercel");
    expect(vercel!.allowedTools).toEqual(["publish_page", "unpublish_page"]);
    expect(vercel!.updatedAt).toBe(1700000000000);

    // Custom: NOT modified (populated allowedTools even though it has injectionTemplates).
    const custom = creds.find((c) => c.service === "custom_service");
    expect(custom!.allowedTools).toEqual(["custom_tool_a", "custom_tool_b"]);
    expect(custom!.updatedAt).toBe(1700000000000);

    // Slack: NOT modified (no injectionTemplates).
    const slack = creds.find((c) => c.service === "slack");
    expect(slack!.allowedTools).toEqual([]);
    expect(slack!.updatedAt).toBe(1700000000000);
  });

  test("unrecognized future schema version is a no-op", () => {
    writeMetadata({
      version: 99,
      credentials: [makeSentryCredential()],
    });
    const before = readFileSync(metadataPath, "utf-8");

    expect(() =>
      backfillBashAllowedToolsForInjectionCredentialsMigration.run(
        workspaceDir,
      ),
    ).not.toThrow();

    expect(readFileSync(metadataPath, "utf-8")).toBe(before);
  });

  test("non-object root is a no-op", () => {
    writeMetadata([1, 2, 3]);
    const before = readFileSync(metadataPath, "utf-8");

    expect(() =>
      backfillBashAllowedToolsForInjectionCredentialsMigration.run(
        workspaceDir,
      ),
    ).not.toThrow();

    expect(readFileSync(metadataPath, "utf-8")).toBe(before);
  });

  test("file with no version field defaults to version 1 and processes", () => {
    writeMetadata({
      credentials: [makeSentryCredential()],
    });

    backfillBashAllowedToolsForInjectionCredentialsMigration.run(workspaceDir);

    const result = readMetadata();
    const creds = result.credentials as Record<string, unknown>[];
    const sentry = creds.find((c) => c.service === "sentry");
    expect(sentry!.allowedTools).toEqual(["bash"]);
  });

  test("down() is a no-op", () => {
    writeMetadata({
      version: 5,
      credentials: [makeSentryCredential()],
    });
    backfillBashAllowedToolsForInjectionCredentialsMigration.run(workspaceDir);
    const after = readFileSync(metadataPath, "utf-8");

    expect(() =>
      backfillBashAllowedToolsForInjectionCredentialsMigration.down(
        workspaceDir,
      ),
    ).not.toThrow();

    expect(readFileSync(metadataPath, "utf-8")).toBe(after);
  });

  test("post-080+081 scenario: Vercel has no bash, injection services have bash", () => {
    // Simulate state after migration 080 has already run:
    // - Vercel: hardened (no injectionTemplates, allowedTools = publish tools)
    // - Sentry: still has injectionTemplates, empty allowedTools
    writeMetadata({
      version: 5,
      credentials: [makeHardenedVercelCredential(), makeSentryCredential()],
    });

    backfillBashAllowedToolsForInjectionCredentialsMigration.run(workspaceDir);

    const result = readMetadata();
    const creds = result.credentials as Record<string, unknown>[];

    // Vercel: should still have publish tools only, no bash.
    const vercel = creds.find((c) => c.service === "vercel");
    expect(vercel!.allowedTools).toEqual(["publish_page", "unpublish_page"]);

    // Sentry: should now have bash.
    const sentry = creds.find((c) => c.service === "sentry");
    expect(sentry!.allowedTools).toEqual(["bash"]);
  });
});
