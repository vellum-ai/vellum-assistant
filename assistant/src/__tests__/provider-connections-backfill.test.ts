/**
 * Boot-time provider_connection backfill: an existing user connection for
 * the entry's provider must win over the mode-derived default.
 *
 * On managed (platform-hosted) installs the mode default is the billed
 * `vellum` connection — stamping it onto a connection-less BYOK-intent
 * profile permanently routes the user's own-key setup through managed
 * billing. On your-own installs the mode default creates a parallel
 * `<provider>-personal` row with an empty credential slot even when a
 * custom-named connection already exists.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { loadRawConfig } from "../config/loader.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { providerConnections } from "../persistence/schema/index.js";
import { runProviderConnectionsBackfill } from "../providers/inference/backfill.js";
import {
  createConnection,
  getConnection,
  listConnections,
} from "../providers/inference/connections.js";

await initializeDb();

const originalIsPlatform = process.env.IS_PLATFORM;

function seedConfig(profiles: Record<string, unknown>): void {
  writeFileSync(
    join(process.env.VELLUM_WORKSPACE_DIR!, "config.json"),
    JSON.stringify({ llm: { profiles } }),
  );
}

function backfilledConnection(profileName: string): unknown {
  const llm = loadRawConfig().llm as {
    profiles?: Record<string, Record<string, unknown>>;
  };
  return llm.profiles?.[profileName]?.provider_connection;
}

beforeEach(() => {
  getDb().delete(providerConnections).run();
});

afterEach(() => {
  if (originalIsPlatform === undefined) {
    delete process.env.IS_PLATFORM;
  } else {
    process.env.IS_PLATFORM = originalIsPlatform;
  }
});

test("managed mode prefers an existing user connection over the vellum default", () => {
  process.env.IS_PLATFORM = "true";
  const created = createConnection(getDb(), {
    name: "anthropic-personal",
    provider: "anthropic",
    auth: { type: "api_key", credential: "credential/anthropic/api_key" },
  });
  expect(created.ok).toBe(true);
  seedConfig({ byok: { provider: "anthropic", model: "claude-fable-5" } });

  runProviderConnectionsBackfill(getDb());

  expect(backfilledConnection("byok")).toBe("anthropic-personal");
});

test("managed mode still stamps vellum when no user connection exists", () => {
  process.env.IS_PLATFORM = "true";
  seedConfig({ byok: { provider: "anthropic", model: "claude-fable-5" } });

  runProviderConnectionsBackfill(getDb());

  expect(backfilledConnection("byok")).toBe("vellum");
});

test("your-own mode reuses a custom-named connection instead of creating -personal", () => {
  delete process.env.IS_PLATFORM;
  const created = createConnection(getDb(), {
    name: "my-anthropic",
    provider: "anthropic",
    auth: { type: "api_key", credential: "credential/anthropic/api_key" },
  });
  expect(created.ok).toBe(true);
  seedConfig({ byok: { provider: "anthropic", model: "claude-fable-5" } });

  runProviderConnectionsBackfill(getDb());

  expect(backfilledConnection("byok")).toBe("my-anthropic");
  expect(getConnection(getDb(), "anthropic-personal")).toBeNull();
  // Exactly the user's connection — no parallel row was created.
  expect(
    listConnections(getDb(), { provider: "anthropic" }).map((c) => c.name),
  ).toEqual(["my-anthropic"]);
});
