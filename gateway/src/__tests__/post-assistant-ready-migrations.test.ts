/**
 * Unit tests for the migration-readiness decision the gateway uses before
 * running assistant-DB-touching startup work (guardian binding backfill, data
 * migrations, voice syncs).
 *
 * The assistant's `health` route is exempt from its own migration-readiness
 * gate, so a successful call is NOT sufficient to proceed — the gateway must
 * also see migrations reported as ready, else the guardian-binding INSERTs race
 * async migrations into a "no such table" error on a warm-pool claim.
 */

import { describe, expect, test } from "bun:test";

import {
  type AssistantHealth,
  assistantReportsMigrationsReady,
} from "../post-assistant-ready.js";

describe("assistantReportsMigrationsReady", () => {
  test("ready: a healthy response omits dbMigrations entirely", () => {
    const health: AssistantHealth = { status: "healthy" };
    expect(assistantReportsMigrationsReady(health)).toBe(true);
  });

  test("ready: dbMigrations present with ready:true", () => {
    const health: AssistantHealth = {
      status: "healthy",
      dbMigrations: { ready: true, state: "ready" },
    };
    expect(assistantReportsMigrationsReady(health)).toBe(true);
  });

  test("not ready: migrations still running", () => {
    const health: AssistantHealth = {
      status: "MIGRATING",
      dbMigrations: { ready: false, state: "running" },
    };
    expect(assistantReportsMigrationsReady(health)).toBe(false);
  });

  test("not ready: migrations failed", () => {
    const health: AssistantHealth = {
      status: "ERROR",
      dbMigrations: { ready: false, state: "failed" },
    };
    expect(assistantReportsMigrationsReady(health)).toBe(false);
  });

  test("tolerates null/undefined health (treated as ready — nothing to wait on)", () => {
    expect(assistantReportsMigrationsReady(null)).toBe(true);
    expect(assistantReportsMigrationsReady(undefined)).toBe(true);
  });
});
