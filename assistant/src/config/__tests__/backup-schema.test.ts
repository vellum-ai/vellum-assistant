import { describe, expect, test } from "bun:test";

import {
  BackupConfigSchema,
  BackupDestinationSchema,
  BackupOffsiteConfigSchema,
} from "../schemas/backup.js";

describe("BackupConfigSchema", () => {
  test("empty object parses to full defaults (disabled, sensible intervals, iCloud default)", () => {
    const parsed = BackupConfigSchema.parse({});
    expect(parsed).toEqual({
      enabled: false,
      intervalHours: 6,
      retention: 7,
      offsite: { enabled: true, destinations: null },
      localDirectory: null,
    });
  });

  test("rejects intervalHours: 0 (must be >= 1)", () => {
    const result = BackupConfigSchema.safeParse({ intervalHours: 0 });
    expect(result.success).toBe(false);
  });

  test("rejects intervalHours above max 168", () => {
    const result = BackupConfigSchema.safeParse({ intervalHours: 169 });
    expect(result.success).toBe(false);
  });

  test("rejects retention: 0 (must be >= 1)", () => {
    const result = BackupConfigSchema.safeParse({ retention: 0 });
    expect(result.success).toBe(false);
  });

  test("rejects retention above max 100", () => {
    const result = BackupConfigSchema.safeParse({ retention: 101 });
    expect(result.success).toBe(false);
  });

  test("valid custom values round-trip", () => {
    const input = {
      enabled: true,
      intervalHours: 12,
      retention: 30,
      offsite: {
        enabled: false,
        destinations: [{ path: "/mnt/backups", encrypt: true }],
      },
      localDirectory: "/var/backups/vellum",
    };
    const parsed = BackupConfigSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  test("offsite.destinations with only path defaults encrypt to true", () => {
    const parsed = BackupConfigSchema.parse({
      offsite: {
        destinations: [{ path: "/tmp/a" }, { path: "/tmp/b" }],
      },
    });
    expect(parsed.offsite.destinations).toEqual([
      { path: "/tmp/a", encrypt: true },
      { path: "/tmp/b", encrypt: true },
    ]);
  });

  test("offsite.destinations honors explicit encrypt: false (plaintext allowed)", () => {
    const parsed = BackupConfigSchema.parse({
      offsite: {
        destinations: [{ path: "/tmp/a", encrypt: false }],
      },
    });
    expect(parsed.offsite.destinations).toEqual([
      { path: "/tmp/a", encrypt: false },
    ]);
  });

  test("offsite.destinations allows mixed encryption across destinations", () => {
    const parsed = BackupConfigSchema.parse({
      offsite: {
        destinations: [
          { path: "/tmp/a", encrypt: true },
          { path: "/tmp/b", encrypt: false },
        ],
      },
    });
    expect(parsed.offsite.destinations).toEqual([
      { path: "/tmp/a", encrypt: true },
      { path: "/tmp/b", encrypt: false },
    ]);
  });

  test("offsite.destinations: [] parses as an explicit empty array (distinct from null)", () => {
    const parsed = BackupConfigSchema.parse({
      offsite: { destinations: [] },
    });
    expect(parsed.offsite.destinations).toEqual([]);
    // Distinct from null (the iCloud-default sentinel).
    expect(parsed.offsite.destinations).not.toBe(null);
  });

  test("partial config with only enabled: true fills in defaults", () => {
    const parsed = BackupConfigSchema.parse({ enabled: true });
    expect(parsed).toEqual({
      enabled: true,
      intervalHours: 6,
      retention: 7,
      offsite: { enabled: true, destinations: null },
      localDirectory: null,
    });
  });
});

describe("BackupDestinationSchema", () => {
  test("defaults encrypt to true when omitted", () => {
    const parsed = BackupDestinationSchema.parse({ path: "/tmp/x" });
    expect(parsed).toEqual({ path: "/tmp/x", encrypt: true });
  });

  test("requires path", () => {
    const result = BackupDestinationSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("BackupOffsiteConfigSchema", () => {
  test("empty object defaults to enabled=true, destinations=null", () => {
    expect(BackupOffsiteConfigSchema.parse({})).toEqual({
      enabled: true,
      destinations: null,
    });
  });
});
