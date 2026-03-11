import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { credentialKey } from "../security/credential-key.js";
import {
  _setMetadataPath,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";
import {
  resolveById,
  resolveByServiceField,
  resolveCredentialRef,
  resolveForDomain,
} from "../tools/credentials/resolve.js";

const TEST_DIR = join(
  tmpdir(),
  `vellum-credresolve-test-${randomBytes(4).toString("hex")}`,
);
const META_PATH = join(TEST_DIR, "metadata.json");

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  _setMetadataPath(META_PATH);
});

afterAll(() => {
  _setMetadataPath(null);
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

describe("credential resolver", () => {
  describe("resolveByServiceField", () => {
    test("resolves existing credential", () => {
      const created = upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });

      const result = resolveByServiceField("github", "token");
      expect(result).toBeDefined();
      expect(result!.credentialId).toBe(created.credentialId);
      expect(result!.service).toBe("github");
      expect(result!.field).toBe("token");
      expect(result!.storageKey).toBe(credentialKey("github", "token"));
      expect(result!.metadata.allowedTools).toEqual([
        "browser_fill_credential",
      ]);
    });

    test("returns undefined for non-existent credential", () => {
      expect(resolveByServiceField("nonexistent", "field")).toBeUndefined();
    });

    test("includes alias when set", () => {
      upsertCredentialMetadata("fal", "api_key", { alias: "fal-primary" });
      const result = resolveByServiceField("fal", "api_key");
      expect(result!.alias).toBe("fal-primary");
    });

    test("alias is undefined when not set", () => {
      upsertCredentialMetadata("fal", "api_key");
      const result = resolveByServiceField("fal", "api_key");
      expect(result!.alias).toBeUndefined();
    });

    test("includes injection templates when set", () => {
      upsertCredentialMetadata("fal", "api_key", {
        injectionTemplates: [
          {
            hostPattern: "*.fal.ai",
            injectionType: "header",
            headerName: "Authorization",
            valuePrefix: "Key ",
          },
        ],
      });
      const result = resolveByServiceField("fal", "api_key");
      expect(result!.injectionTemplates).toHaveLength(1);
      expect(result!.injectionTemplates[0].hostPattern).toBe("*.fal.ai");
      expect(result!.injectionTemplates[0].injectionType).toBe("header");
    });

    test("injection templates default to empty array", () => {
      upsertCredentialMetadata("github", "token");
      const result = resolveByServiceField("github", "token");
      expect(result!.injectionTemplates).toEqual([]);
    });
  });

  describe("resolveById", () => {
    test("resolves existing credential by ID", () => {
      const created = upsertCredentialMetadata("gmail", "password");

      const result = resolveById(created.credentialId);
      expect(result).toBeDefined();
      expect(result!.credentialId).toBe(created.credentialId);
      expect(result!.service).toBe("gmail");
      expect(result!.field).toBe("password");
      expect(result!.storageKey).toBe(credentialKey("gmail", "password"));
    });

    test("returns undefined for non-existent ID", () => {
      expect(resolveById("non-existent-id")).toBeUndefined();
    });

    test("includes alias and injection templates", () => {
      const created = upsertCredentialMetadata("replicate", "api_key", {
        alias: "replicate-prod",
        injectionTemplates: [
          {
            hostPattern: "api.replicate.com",
            injectionType: "header",
            headerName: "Authorization",
            valuePrefix: "Bearer ",
          },
        ],
      });

      const result = resolveById(created.credentialId);
      expect(result!.alias).toBe("replicate-prod");
      expect(result!.injectionTemplates).toHaveLength(1);
      expect(result!.injectionTemplates[0].valuePrefix).toBe("Bearer ");
    });

    test("deterministic lookup among multiple credentials for same provider", () => {
      const cred1 = upsertCredentialMetadata("openai", "api_key_primary");
      const cred2 = upsertCredentialMetadata("openai", "api_key_secondary");

      const result1 = resolveById(cred1.credentialId);
      const result2 = resolveById(cred2.credentialId);

      expect(result1!.credentialId).toBe(cred1.credentialId);
      expect(result1!.field).toBe("api_key_primary");
      expect(result2!.credentialId).toBe(cred2.credentialId);
      expect(result2!.field).toBe("api_key_secondary");
      expect(result1!.credentialId).not.toBe(result2!.credentialId);
    });
  });

  describe("cross-resolution", () => {
    test("service/field and ID resolve to same credential", () => {
      const created = upsertCredentialMetadata("github", "token");

      const byServiceField = resolveByServiceField("github", "token");
      const byId = resolveById(created.credentialId);

      expect(byServiceField).toBeDefined();
      expect(byId).toBeDefined();
      expect(byServiceField!.credentialId).toBe(byId!.credentialId);
      expect(byServiceField!.storageKey).toBe(byId!.storageKey);
    });

    test("both paths return identical injection templates", () => {
      const templates = [
        {
          hostPattern: "*.fal.ai",
          injectionType: "header" as const,
          headerName: "Authorization",
          valuePrefix: "Key ",
        },
      ];
      const created = upsertCredentialMetadata("fal", "api_key", {
        injectionTemplates: templates,
        alias: "fal-test",
      });

      const byServiceField = resolveByServiceField("fal", "api_key");
      const byId = resolveById(created.credentialId);

      expect(byServiceField!.injectionTemplates).toEqual(
        byId!.injectionTemplates,
      );
      expect(byServiceField!.alias).toBe(byId!.alias);
    });
  });

  describe("storage key format", () => {
    test("storage key follows credential/{service}/{field} format", () => {
      upsertCredentialMetadata("my-service", "api-key");
      const result = resolveByServiceField("my-service", "api-key");
      expect(result!.storageKey).toBe(credentialKey("my-service", "api-key"));
    });
  });

  describe("resolveForDomain", () => {
    test("returns credentials matching the hostname", () => {
      upsertCredentialMetadata("fal", "api_key", {
        injectionTemplates: [
          {
            hostPattern: "*.fal.ai",
            injectionType: "header",
            headerName: "Authorization",
            valuePrefix: "Key ",
          },
        ],
      });
      upsertCredentialMetadata("replicate", "api_key", {
        injectionTemplates: [
          {
            hostPattern: "api.replicate.com",
            injectionType: "header",
            headerName: "Authorization",
            valuePrefix: "Bearer ",
          },
        ],
      });

      const results = resolveForDomain("queue.fal.ai");
      expect(results).toHaveLength(1);
      expect(results[0].service).toBe("fal");
      expect(results[0].injectionTemplates).toHaveLength(1);
      expect(results[0].injectionTemplates[0].valuePrefix).toBe("Key ");
    });

    test("returns empty array when no templates match", () => {
      upsertCredentialMetadata("fal", "api_key", {
        injectionTemplates: [
          {
            hostPattern: "*.fal.ai",
            injectionType: "header",
            headerName: "Authorization",
            valuePrefix: "Key ",
          },
        ],
      });

      const results = resolveForDomain("api.openai.com");
      expect(results).toHaveLength(0);
    });

    test("returns empty array for credentials without injection templates", () => {
      upsertCredentialMetadata("github", "token");

      const results = resolveForDomain("github.com");
      expect(results).toHaveLength(0);
    });

    test("filters injection templates to only matching entries", () => {
      upsertCredentialMetadata("multi", "key", {
        injectionTemplates: [
          {
            hostPattern: "*.fal.ai",
            injectionType: "header",
            headerName: "Authorization",
            valuePrefix: "Key ",
          },
          {
            hostPattern: "*.replicate.com",
            injectionType: "header",
            headerName: "Authorization",
            valuePrefix: "Bearer ",
          },
        ],
      });

      const results = resolveForDomain("api.replicate.com");
      expect(results).toHaveLength(1);
      expect(results[0].injectionTemplates).toHaveLength(1);
      expect(results[0].injectionTemplates[0].hostPattern).toBe(
        "*.replicate.com",
      );
    });

    test("returns multiple credentials when multiple match", () => {
      upsertCredentialMetadata("provider-a", "key1", {
        injectionTemplates: [
          {
            hostPattern: "*.example.com",
            injectionType: "header",
            headerName: "X-Api-Key",
          },
        ],
      });
      upsertCredentialMetadata("provider-b", "key2", {
        injectionTemplates: [
          {
            hostPattern: "*.example.com",
            injectionType: "query",
            queryParamName: "api_key",
          },
        ],
      });

      const results = resolveForDomain("api.example.com");
      expect(results).toHaveLength(2);
      const services = results.map((r) => r.service).sort();
      expect(services).toEqual(["provider-a", "provider-b"]);
    });

    test("exact host pattern matches", () => {
      upsertCredentialMetadata("exact", "key", {
        injectionTemplates: [
          {
            hostPattern: "api.exact.com",
            injectionType: "header",
            headerName: "Authorization",
          },
        ],
      });

      expect(resolveForDomain("api.exact.com")).toHaveLength(1);
      expect(resolveForDomain("other.exact.com")).toHaveLength(0);
    });

    test("matches hostnames case-insensitively", () => {
      upsertCredentialMetadata("casefold", "key", {
        injectionTemplates: [
          {
            hostPattern: "*.Example.COM",
            injectionType: "header",
            headerName: "Authorization",
          },
        ],
      });

      expect(resolveForDomain("api.example.com")).toHaveLength(1);
      expect(resolveForDomain("API.EXAMPLE.COM")).toHaveLength(1);
      expect(resolveForDomain("Api.Example.Com")).toHaveLength(1);
    });
  });

  describe("resolveCredentialRef", () => {
    test("resolves by UUID", () => {
      const created = upsertCredentialMetadata("github", "token");
      const result = resolveCredentialRef(created.credentialId);
      expect(result).toBeDefined();
      expect(result!.credentialId).toBe(created.credentialId);
      expect(result!.service).toBe("github");
    });

    test("resolves by service/field", () => {
      upsertCredentialMetadata("fal", "api_key");
      const result = resolveCredentialRef("fal/api_key");
      expect(result).toBeDefined();
      expect(result!.service).toBe("fal");
      expect(result!.field).toBe("api_key");
    });

    test("returns undefined for unknown UUID", () => {
      expect(
        resolveCredentialRef("00000000-0000-0000-0000-000000000000"),
      ).toBeUndefined();
    });

    test("returns undefined for unknown service/field", () => {
      expect(resolveCredentialRef("nonexistent/field")).toBeUndefined();
    });

    test("returns undefined for empty string", () => {
      expect(resolveCredentialRef("")).toBeUndefined();
    });

    test("returns undefined for whitespace-only string", () => {
      expect(resolveCredentialRef("   ")).toBeUndefined();
    });

    test("returns undefined for malformed ref with no slash", () => {
      expect(resolveCredentialRef("fal")).toBeUndefined();
    });

    test("returns undefined for malformed ref with too many slashes", () => {
      expect(resolveCredentialRef("fal/api/key")).toBeUndefined();
    });

    test("returns undefined for ref with empty service segment", () => {
      expect(resolveCredentialRef("/api_key")).toBeUndefined();
    });

    test("returns undefined for ref with empty field segment", () => {
      expect(resolveCredentialRef("fal/")).toBeUndefined();
    });

    test("UUID takes precedence when both UUID and service/field would match", () => {
      const created = upsertCredentialMetadata("github", "token");
      // The credentialId is a UUID, not a service/field, so resolveById finds it first
      const result = resolveCredentialRef(created.credentialId);
      expect(result).toBeDefined();
      expect(result!.credentialId).toBe(created.credentialId);
    });
  });
});
