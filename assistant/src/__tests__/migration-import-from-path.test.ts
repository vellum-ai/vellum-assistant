/**
 * HTTP tests for JSON `{ path }` on POST /v1/migrations/import and
 * POST /v1/migrations/import-preflight.
 *
 * The daemon only opens a regular `.vbundle` that realpath-resolves
 * under `${workspace}/.restore-staging/`.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

mock.module("../permissions/trust-store.js", () => ({
  getAllRules: () => [],
  isStarterBundleAccepted: () => false,
  clearCache: () => {},
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
  getGatewayPort: () => 7830,
  getRuntimeHttpPort: () => 7821,
  getRuntimeHttpHost: () => "127.0.0.1",
  getRuntimeGatewayOriginSecret: () => undefined,
  getIngressPublicBaseUrl: () => undefined,
  setIngressPublicBaseUrl: () => {},
}));

import { defaultV1Options } from "../runtime/migrations/__tests__/v1-test-helpers.js";
import { RESTORE_STAGING_DIRNAME } from "../runtime/migrations/staged-import-path.js";
import { buildVBundle } from "../runtime/migrations/vbundle-builder.js";
import {
  handleMigrationImport,
  handleMigrationImportPreflight,
} from "../runtime/routes/migration-routes.js";
import { callHandler } from "./helpers/call-route-handler.js";

const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;

function freshWorkspaceRoot(): string {
  const parent = realpathSync(
    mkdtempSync(join(tmpdir(), "migration-import-from-path-")),
  );
  const workspaceDir = join(parent, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  return workspaceDir;
}

function setWorkspaceDir(dir: string): void {
  process.env.VELLUM_WORKSPACE_DIR = dir;
}

function makeSmallValidBundle(): Uint8Array {
  const { archive } = buildVBundle({
    files: [
      {
        path: "workspace/data/db/assistant.db",
        data: new TextEncoder().encode("SQLite format 3\0"),
      },
      {
        path: "workspace/config.json",
        data: new TextEncoder().encode(
          JSON.stringify({ provider: "anthropic", model: "test-model" }),
        ),
      },
    ],
    ...defaultV1Options(),
  });
  return archive;
}

function stageBundle(workspaceDir: string, archive: Uint8Array): string {
  const staging = join(workspaceDir, RESTORE_STAGING_DIRNAME);
  mkdirSync(staging, { recursive: true });
  const filename = "backup.vbundle";
  writeFileSync(join(staging, filename), archive);
  return `${RESTORE_STAGING_DIRNAME}/${filename}`;
}

interface ImportCommitResponse {
  success: boolean;
  summary: {
    total_files: number;
    files_created: number;
    files_overwritten: number;
    files_skipped: number;
    backups_created: number;
  };
  files: Array<{ path: string }>;
  manifest: Record<string, unknown>;
}

interface PreflightResponse {
  can_import: boolean;
  summary?: {
    files_to_create: number;
    files_to_overwrite: number;
    files_unchanged: number;
    total_files: number;
  };
  validation?: { is_valid: false; errors: Array<{ code: string }> };
}

interface BadRequestResponse {
  error: { code: string; message: string };
}

let testWorkspaceRoot: string;
let testParent: string;

beforeEach(() => {
  testWorkspaceRoot = freshWorkspaceRoot();
  testParent = join(testWorkspaceRoot, "..");
  setWorkspaceDir(testWorkspaceRoot);
});

afterEach(() => {
  try {
    rmSync(testParent, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

afterAll(() => {
  if (originalWorkspaceDir !== undefined) {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  } else {
    delete process.env.VELLUM_WORKSPACE_DIR;
  }
});

describe("handleMigrationImport — JSON {path} body", () => {
  test("happy path: streams a staged .vbundle and imports it", async () => {
    const relativePath = stageBundle(
      testWorkspaceRoot,
      makeSmallValidBundle(),
    );

    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: relativePath }),
    });

    const res = await callHandler(handleMigrationImport, req);
    const body = (await res.json()) as ImportCommitResponse;

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.summary.total_files).toBeGreaterThan(0);
    expect(body.files.length).toBeGreaterThan(0);
    expect(existsSync(join(testWorkspaceRoot, "data", "db", "assistant.db"))).toBe(
      true,
    );
    expect(existsSync(join(testWorkspaceRoot, "config.json"))).toBe(true);
  });

  test("absolute path inside staging is accepted", async () => {
    const relativePath = stageBundle(
      testWorkspaceRoot,
      makeSmallValidBundle(),
    );
    const absolutePath = join(testWorkspaceRoot, relativePath);

    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: absolutePath }),
    });

    const res = await callHandler(handleMigrationImport, req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportCommitResponse;
    expect(body.success).toBe(true);
  });

  test("both url and path returns 400", async () => {
    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://storage.googleapis.com/b/o?X-Goog-Signature=x",
        path: `${RESTORE_STAGING_DIRNAME}/backup.vbundle`,
      }),
    });

    const res = await callHandler(handleMigrationImport, req);
    const body = (await res.json()) as BadRequestResponse;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("exactly one");
  });

  test("missing staged file returns 400", async () => {
    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: `${RESTORE_STAGING_DIRNAME}/missing.vbundle`,
      }),
    });

    const res = await callHandler(handleMigrationImport, req);
    const body = (await res.json()) as BadRequestResponse;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message.toLowerCase()).toContain("not found");
  });

  test("traversal out of staging returns 400", async () => {
    writeFileSync(join(testWorkspaceRoot, "secret.vbundle"), "nope");

    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: `${RESTORE_STAGING_DIRNAME}/../secret.vbundle`,
      }),
    });

    const res = await callHandler(handleMigrationImport, req);
    const body = (await res.json()) as BadRequestResponse;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message.toLowerCase()).toContain("staging");
  });

  test("path outside the workspace returns 400", async () => {
    const outside = join(testParent, "outside.vbundle");
    writeFileSync(outside, "nope");

    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: outside }),
    });

    const res = await callHandler(handleMigrationImport, req);
    const body = (await res.json()) as BadRequestResponse;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message.toLowerCase()).toContain("staging");
  });

  test("symlink in staging returns 400", async () => {
    const relativePath = stageBundle(
      testWorkspaceRoot,
      makeSmallValidBundle(),
    );
    const target = join(testWorkspaceRoot, relativePath);
    const link = join(testWorkspaceRoot, RESTORE_STAGING_DIRNAME, "alias.vbundle");
    symlinkSync(target, link);

    const req = new Request("http://localhost/v1/migrations/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: `${RESTORE_STAGING_DIRNAME}/alias.vbundle`,
      }),
    });

    const res = await callHandler(handleMigrationImport, req);
    const body = (await res.json()) as BadRequestResponse;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message.toLowerCase()).toContain("symlink");
  });
});

describe("handleMigrationImportPreflight — JSON {path} body", () => {
  test("happy path: analyzes a staged .vbundle without writing files", async () => {
    const relativePath = stageBundle(
      testWorkspaceRoot,
      makeSmallValidBundle(),
    );

    const req = new Request("http://localhost/v1/migrations/import-preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: relativePath }),
    });

    const res = await callHandler(handleMigrationImportPreflight, req);
    const body = (await res.json()) as PreflightResponse;

    expect(res.status).toBe(200);
    expect(body.can_import).toBe(true);
    expect(body.summary?.total_files).toBeGreaterThan(0);
    expect(existsSync(join(testWorkspaceRoot, "config.json"))).toBe(false);
  });

  test("empty path returns 400", async () => {
    const req = new Request("http://localhost/v1/migrations/import-preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "" }),
    });

    const res = await callHandler(handleMigrationImportPreflight, req);
    const body = (await res.json()) as BadRequestResponse;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("non-.vbundle staging file returns 400", async () => {
    const staging = join(testWorkspaceRoot, RESTORE_STAGING_DIRNAME);
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "notes.txt"), "nope");

    const req = new Request("http://localhost/v1/migrations/import-preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: `${RESTORE_STAGING_DIRNAME}/notes.txt` }),
    });

    const res = await callHandler(handleMigrationImportPreflight, req);
    const body = (await res.json()) as BadRequestResponse;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message.toLowerCase()).toContain(".vbundle");
  });
});
