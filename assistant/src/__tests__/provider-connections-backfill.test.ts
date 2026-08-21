/**
 * Boot-time connection-row repair: config.json is read but never written,
 * while a bare-vendor profile whose row is missing still gets the
 * conventional `<provider>-personal` row created.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { providerConnections } from "../persistence/schema/index.js";
import { ensureProviderConnectionRows } from "../providers/inference/backfill.js";
import {
  createConnection,
  getConnection,
  listConnections,
} from "../providers/inference/connections.js";

await initializeDb();

const originalIsPlatform = process.env.IS_PLATFORM;

function configPath(): string {
  return join(process.env.VELLUM_WORKSPACE_DIR!, "config.json");
}

function seedConfig(llm: Record<string, unknown>): void {
  writeFileSync(configPath(), JSON.stringify({ llm }));
}

/** Run the repair and assert it performed zero config writes. */
function runExpectingNoConfigWrite(): void {
  const before = readFileSync(configPath(), "utf-8");
  ensureProviderConnectionRows(getDb());
  expect(readFileSync(configPath(), "utf-8")).toBe(before);
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

test("a bare-vendor profile with a missing row gets its -personal row created, with no config write", () => {
  delete process.env.IS_PLATFORM;
  seedConfig({
    profiles: { byok: { provider: "anthropic", model: "claude-fable-5" } },
  });

  runExpectingNoConfigWrite();

  const row = getConnection(getDb(), "anthropic-personal");
  expect(row?.provider).toBe("anthropic");
  expect(row?.auth).toEqual({
    type: "api_key",
    credential: "credential/anthropic/api_key",
  });
});

test("the legacy llm.default blob gets its row ensured too", () => {
  delete process.env.IS_PLATFORM;
  seedConfig({
    default: { provider: "openai", model: "gpt-5.5" },
  });

  runExpectingNoConfigWrite();

  expect(getConnection(getDb(), "openai-personal")?.provider).toBe("openai");
});

test("an existing compatible connection suppresses row creation", () => {
  delete process.env.IS_PLATFORM;
  const created = createConnection(getDb(), {
    name: "my-anthropic",
    provider: "anthropic",
    auth: { type: "api_key", credential: "credential/anthropic/api_key" },
  });
  expect(created.ok).toBe(true);
  seedConfig({
    profiles: { byok: { provider: "anthropic", model: "claude-fable-5" } },
  });

  runExpectingNoConfigWrite();

  expect(getConnection(getDb(), "anthropic-personal")).toBeNull();
  expect(
    listConnections(getDb(), { provider: "anthropic" }).map((c) => c.name),
  ).toEqual(["my-anthropic"]);
});

test("managed mode creates no personal row for managed-routable providers", () => {
  process.env.IS_PLATFORM = "true";
  seedConfig({
    profiles: { byok: { provider: "anthropic", model: "claude-fable-5" } },
  });

  runExpectingNoConfigWrite();

  expect(getConnection(getDb(), "anthropic-personal")).toBeNull();
  // The canonical vellum row is seeded and serves the managed route.
  expect(getConnection(getDb(), "vellum")?.provider).toBe("vellum");
});

test("routing identities and entry-name providers get no bootstrap rows", () => {
  delete process.env.IS_PLATFORM;
  seedConfig({
    profiles: {
      managedRoute: { provider: "vellum", model: "claude-fable-5" },
      subscription: { provider: "chatgpt", model: "gpt-5.5" },
      entry: { provider: "my-custom-entry", model: "some-model" },
    },
  });

  runExpectingNoConfigWrite();

  expect(getConnection(getDb(), "vellum-personal")).toBeNull();
  expect(getConnection(getDb(), "chatgpt-personal")).toBeNull();
  expect(getConnection(getDb(), "my-custom-entry-personal")).toBeNull();
  expect(getConnection(getDb(), "my-custom-entry")).toBeNull();
});

test("ollama is keyless: its bootstrap row carries no credential", () => {
  delete process.env.IS_PLATFORM;
  seedConfig({
    profiles: { local: { provider: "ollama", model: "llama3" } },
  });

  runExpectingNoConfigWrite();

  expect(getConnection(getDb(), "ollama-personal")?.auth).toEqual({
    type: "none",
  });
});
