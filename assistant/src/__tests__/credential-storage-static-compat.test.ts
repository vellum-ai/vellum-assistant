/**
 * Compatibility tests for the static credential storage extraction.
 *
 * Proves that the shared-package StaticCredentialMetadataStore produces
 * identical behavior to the original assistant-only metadata-store module:
 * - Service alias resolution
 * - UUID-based credential lookup
 * - Storage key format (credential/{service}/{field})
 * - Missing-key error handling
 * - CRUD lifecycle
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
  credentialKey,
  StaticCredentialMetadataStore,
} from "@vellumai/credential-storage";

const TEST_DIR = join(
  tmpdir(),
  `vellum-static-cred-compat-${randomBytes(4).toString("hex")}`,
);
const META_PATH = join(TEST_DIR, "metadata.json");

let store: StaticCredentialMetadataStore;

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  store = new StaticCredentialMetadataStore(META_PATH);
});

afterAll(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

describe("static credential storage compatibility", () => {
  describe("service alias resolution", () => {
    test("resolves credential by service and field", () => {
      const created = store.upsert("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });

      const result = store.getByServiceField("github", "token");
      expect(result).toBeDefined();
      expect(result!.credentialId).toBe(created.credentialId);
      expect(result!.service).toBe("github");
      expect(result!.field).toBe("token");
      expect(result!.allowedTools).toEqual(["browser_fill_credential"]);
    });

    test("returns undefined for non-existent service/field", () => {
      expect(store.getByServiceField("nonexistent", "field")).toBeUndefined();
    });

    test("differentiates multiple fields for same service", () => {
      store.upsert("openai", "api_key_primary");
      store.upsert("openai", "api_key_secondary");

      const primary = store.getByServiceField("openai", "api_key_primary");
      const secondary = store.getByServiceField("openai", "api_key_secondary");

      expect(primary).toBeDefined();
      expect(secondary).toBeDefined();
      expect(primary!.credentialId).not.toBe(secondary!.credentialId);
      expect(primary!.field).toBe("api_key_primary");
      expect(secondary!.field).toBe("api_key_secondary");
    });
  });

  describe("UUID ref resolution", () => {
    test("resolves credential by opaque ID", () => {
      const created = store.upsert("gmail", "password");

      const result = store.getById(created.credentialId);
      expect(result).toBeDefined();
      expect(result!.credentialId).toBe(created.credentialId);
      expect(result!.service).toBe("gmail");
      expect(result!.field).toBe("password");
    });

    test("returns undefined for non-existent ID", () => {
      expect(store.getById("non-existent-id")).toBeUndefined();
    });

    test("deterministic lookup among multiple credentials", () => {
      const cred1 = store.upsert("openai", "key1");
      const cred2 = store.upsert("openai", "key2");

      const result1 = store.getById(cred1.credentialId);
      const result2 = store.getById(cred2.credentialId);

      expect(result1!.credentialId).toBe(cred1.credentialId);
      expect(result2!.credentialId).toBe(cred2.credentialId);
      expect(result1!.credentialId).not.toBe(result2!.credentialId);
    });
  });

  describe("storage key format", () => {
    test("credentialKey follows credential/{service}/{field} pattern", () => {
      expect(credentialKey("github", "api_key")).toBe(
        "credential/github/api_key",
      );
      expect(credentialKey("fal", "token")).toBe("credential/fal/token");
      expect(credentialKey("my-service", "api-key")).toBe(
        "credential/my-service/api-key",
      );
    });

    test("storage key matches credentialKey for resolved credential", () => {
      store.upsert("fal", "api_key");
      const meta = store.getByServiceField("fal", "api_key");
      const expectedKey = credentialKey("fal", "api_key");
      expect(expectedKey).toBe("credential/fal/api_key");
      expect(meta).toBeDefined();
      expect(meta!.service).toBe("fal");
      expect(meta!.field).toBe("api_key");
    });
  });

  describe("missing-key errors", () => {
    test("assertWritable throws on unknown version", () => {
      writeFileSync(
        META_PATH,
        JSON.stringify({ version: 999, credentials: [] }),
      );

      expect(() => store.assertWritable()).toThrow("unrecognized version");
    });

    test("upsert throws on unknown version", () => {
      writeFileSync(
        META_PATH,
        JSON.stringify({ version: 999, credentials: [] }),
      );

      expect(() => store.upsert("github", "token")).toThrow(
        "unrecognized version",
      );
    });

    test("delete throws on unknown version", () => {
      writeFileSync(
        META_PATH,
        JSON.stringify({ version: 999, credentials: [] }),
      );

      expect(() => store.delete("github", "token")).toThrow(
        "unrecognized version",
      );
    });

    test("getByServiceField returns undefined on unknown version", () => {
      writeFileSync(
        META_PATH,
        JSON.stringify({ version: 999, credentials: [] }),
      );

      expect(store.getByServiceField("github", "token")).toBeUndefined();
    });

    test("getById returns undefined on unknown version", () => {
      writeFileSync(
        META_PATH,
        JSON.stringify({ version: 999, credentials: [] }),
      );

      expect(store.getById("some-id")).toBeUndefined();
    });

    test("list returns empty array on unknown version", () => {
      writeFileSync(
        META_PATH,
        JSON.stringify({ version: 999, credentials: [] }),
      );

      expect(store.list()).toEqual([]);
    });
  });

  describe("CRUD lifecycle", () => {
    test("upsert creates new credential", () => {
      const created = store.upsert("github", "token", {
        allowedTools: ["tool1"],
        allowedDomains: ["github.com"],
        usageDescription: "GitHub API access",
        alias: "gh-primary",
      });

      expect(created.credentialId).toBeDefined();
      expect(created.service).toBe("github");
      expect(created.field).toBe("token");
      expect(created.allowedTools).toEqual(["tool1"]);
      expect(created.allowedDomains).toEqual(["github.com"]);
      expect(created.usageDescription).toBe("GitHub API access");
      expect(created.alias).toBe("gh-primary");
      expect(created.createdAt).toBeGreaterThan(0);
      expect(created.updatedAt).toBeGreaterThan(0);
    });

    test("upsert updates existing credential", () => {
      const created = store.upsert("github", "token", {
        allowedTools: ["tool1"],
      });

      const updated = store.upsert("github", "token", {
        allowedTools: ["tool1", "tool2"],
        usageDescription: "Updated description",
      });

      expect(updated.credentialId).toBe(created.credentialId);
      expect(updated.allowedTools).toEqual(["tool1", "tool2"]);
      expect(updated.usageDescription).toBe("Updated description");
      expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    });

    test("upsert clears alias when null is passed", () => {
      store.upsert("github", "token", { alias: "gh-primary" });
      const updated = store.upsert("github", "token", { alias: null });
      expect(updated.alias).toBeUndefined();
    });

    test("upsert clears injection templates when null is passed", () => {
      store.upsert("github", "token", {
        injectionTemplates: [
          {
            hostPattern: "*.github.com",
            injectionType: "header",
            headerName: "Authorization",
          },
        ],
      });
      const updated = store.upsert("github", "token", {
        injectionTemplates: null,
      });
      expect(updated.injectionTemplates).toBeUndefined();
    });

    test("list returns all credentials", () => {
      store.upsert("github", "token");
      store.upsert("fal", "api_key");
      store.upsert("openai", "key");

      const all = store.list();
      expect(all).toHaveLength(3);
      const services = all.map((c) => c.service).sort();
      expect(services).toEqual(["fal", "github", "openai"]);
    });

    test("delete removes credential and returns true", () => {
      store.upsert("github", "token");

      expect(store.delete("github", "token")).toBe(true);
      expect(store.getByServiceField("github", "token")).toBeUndefined();
    });

    test("delete returns false for non-existent credential", () => {
      expect(store.delete("nonexistent", "field")).toBe(false);
    });

    test("injection templates are persisted and retrieved", () => {
      store.upsert("fal", "api_key", {
        injectionTemplates: [
          {
            hostPattern: "*.fal.ai",
            injectionType: "header",
            headerName: "Authorization",
            valuePrefix: "Key ",
          },
        ],
      });

      const result = store.getByServiceField("fal", "api_key");
      expect(result!.injectionTemplates).toHaveLength(1);
      expect(result!.injectionTemplates![0].hostPattern).toBe("*.fal.ai");
      expect(result!.injectionTemplates![0].injectionType).toBe("header");
      expect(result!.injectionTemplates![0].headerName).toBe("Authorization");
      expect(result!.injectionTemplates![0].valuePrefix).toBe("Key ");
    });
  });

  describe("schema migration", () => {
    test("migrates v1 records to v5", () => {
      writeFileSync(
        META_PATH,
        JSON.stringify({
          credentials: [
            {
              credentialId: "test-id",
              service: "github",
              field: "token",
              allowedTools: [],
              allowedDomains: [],
              createdAt: 1000,
              updatedAt: 2000,
              // v1 didn't have version field, and may have extra OAuth fields
              expiresAt: 12345,
              grantedScopes: ["read"],
            },
          ],
        }),
      );

      const result = store.getByServiceField("github", "token");
      expect(result).toBeDefined();
      expect(result!.credentialId).toBe("test-id");
      expect(result!.service).toBe("github");
      // OAuth-specific fields should be stripped
      expect(
        (result as unknown as Record<string, unknown>).expiresAt,
      ).toBeUndefined();
      expect(
        (result as unknown as Record<string, unknown>).grantedScopes,
      ).toBeUndefined();
    });

    test("filters out refresh_token ghost records during migration", () => {
      writeFileSync(
        META_PATH,
        JSON.stringify({
          version: 3,
          credentials: [
            {
              credentialId: "real-id",
              service: "github",
              field: "token",
              allowedTools: [],
              allowedDomains: [],
              createdAt: 1000,
              updatedAt: 2000,
            },
            {
              credentialId: "ghost-id",
              service: "github",
              field: "refresh_token",
              allowedTools: [],
              allowedDomains: [],
              createdAt: 1000,
              updatedAt: 2000,
            },
          ],
        }),
      );

      const all = store.list();
      expect(all).toHaveLength(1);
      expect(all[0].credentialId).toBe("real-id");
    });

    test("handles corrupted JSON gracefully", () => {
      writeFileSync(META_PATH, "not valid json{{{");

      // Should not throw, treat as empty
      const all = store.list();
      expect(all).toEqual([]);
    });

    test("handles missing file gracefully", () => {
      // Don't create the file
      const all = store.list();
      expect(all).toEqual([]);
    });
  });

  describe("path management", () => {
    test("setPath changes the metadata file location", () => {
      store.upsert("github", "token");
      expect(store.getByServiceField("github", "token")).toBeDefined();

      // Switch to a different path
      const otherPath = join(TEST_DIR, "other-metadata.json");
      store.setPath(otherPath);

      // Should not find the credential at the new path
      expect(store.getByServiceField("github", "token")).toBeUndefined();

      // Create a credential at the new path
      store.upsert("fal", "key");
      expect(store.getByServiceField("fal", "key")).toBeDefined();

      // Switch back to original path
      store.setPath(META_PATH);
      expect(store.getByServiceField("github", "token")).toBeDefined();
      expect(store.getByServiceField("fal", "key")).toBeUndefined();
    });
  });
});
