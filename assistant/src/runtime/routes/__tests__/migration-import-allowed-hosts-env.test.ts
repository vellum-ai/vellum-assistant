/**
 * Tests for the import-only host-allowlist plumbing derived from the
 * platform-injected `VELLUM_MIGRATION_IMPORT_ALLOWED_HOSTS` env var.
 *
 * Covers:
 * - `parseMigrationImportAllowedHostsEnv`: unset / empty / whitespace-only
 *   values yield `undefined` (strict default); single + comma-separated
 *   lists are parsed, trimmed, and empties dropped.
 * - `resolveImportValidatorOptions`: an explicit test override wins over the
 *   env allowlist; otherwise the env value is used. This resolver is applied
 *   ONLY by the import handlers — the export upload path stays strict — so it
 *   is the seam that keeps the env allowlist from widening export SSRF.
 */

import { describe, expect, test } from "bun:test";

import {
  parseMigrationImportAllowedHostsEnv,
  resolveImportValidatorOptions,
} from "../migration-routes.js";

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

describe("resolveImportValidatorOptions", () => {
  test("uses the env allowlist when no test override is set", () => {
    expect(
      resolveImportValidatorOptions(undefined, "host.docker.internal"),
    ).toEqual({ allowedHosts: ["host.docker.internal"] });
  });

  test("returns undefined (strict) when neither override nor env is set", () => {
    expect(resolveImportValidatorOptions(undefined, undefined)).toBeUndefined();
  });

  test("test override takes precedence over the env allowlist", () => {
    expect(
      resolveImportValidatorOptions(
        { allowedHosts: ["override.example"] },
        "host.docker.internal",
      ),
    ).toEqual({ allowedHosts: ["override.example"] });
  });
});
