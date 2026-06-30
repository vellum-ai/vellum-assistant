/**
 * Tests for `parseMigrationImportAllowedHostsEnv`, which derives the import
 * URL validator's allowlist from the platform-injected
 * `VELLUM_MIGRATION_IMPORT_ALLOWED_HOSTS` env var.
 *
 * Covers:
 * - Unset / empty / whitespace-only values yield `undefined` so the
 *   validator keeps its strict production default (https + GCS only).
 * - A single host and a comma-separated list are parsed and trimmed.
 * - Empty entries between commas are dropped.
 */

import { describe, expect, test } from "bun:test";

import { parseMigrationImportAllowedHostsEnv } from "../migration-routes.js";

describe("parseMigrationImportAllowedHostsEnv", () => {
  test("returns undefined when unset", () => {
    expect(parseMigrationImportAllowedHostsEnv(undefined)).toBeUndefined();
  });

  test("returns undefined for an empty string", () => {
    expect(parseMigrationImportAllowedHostsEnv("")).toBeUndefined();
  });

  test("returns undefined for whitespace / commas only", () => {
    expect(parseMigrationImportAllowedHostsEnv("   ")).toBeUndefined();
    expect(parseMigrationImportAllowedHostsEnv(" , , ")).toBeUndefined();
  });

  test("parses a single host", () => {
    expect(parseMigrationImportAllowedHostsEnv("host.docker.internal")).toEqual(
      { allowedHosts: ["host.docker.internal"] },
    );
  });

  test("parses and trims a comma-separated list, dropping empties", () => {
    expect(
      parseMigrationImportAllowedHostsEnv(
        " host.docker.internal , ,localhost ",
      ),
    ).toEqual({ allowedHosts: ["host.docker.internal", "localhost"] });
  });
});
