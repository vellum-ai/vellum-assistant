import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { dropWebFetchModeMigration } from "../workspace/migrations/131-drop-web-fetch-mode.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-131-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
}

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("131-drop-web-fetch-mode", () => {
  test("strips mode and keeps the provider", () => {
    writeConfig({
      services: { "web-fetch": { mode: "your-own", provider: "firecrawl" } },
    });

    dropWebFetchModeMigration.run(workspaceDir);

    expect((readConfig().services as any)["web-fetch"]).toEqual({
      provider: "firecrawl",
    });
  });

  test("leaves an entry with no mode untouched", () => {
    writeConfig({ services: { "web-fetch": { provider: "firecrawl" } } });

    dropWebFetchModeMigration.run(workspaceDir);

    expect(readConfig()).toEqual({
      services: { "web-fetch": { provider: "firecrawl" } },
    });
  });

  test("does not touch other services' mode", () => {
    writeConfig({
      services: {
        "web-fetch": { mode: "your-own", provider: "default" },
        "web-search": { mode: "managed", provider: "brave" },
      },
    });

    dropWebFetchModeMigration.run(workspaceDir);

    const services = readConfig().services as any;
    expect(services["web-fetch"]).toEqual({ provider: "default" });
    expect(services["web-search"]).toEqual({
      mode: "managed",
      provider: "brave",
    });
  });

  test("is idempotent", () => {
    writeConfig({
      services: { "web-fetch": { mode: "your-own", provider: "firecrawl" } },
    });

    dropWebFetchModeMigration.run(workspaceDir);
    const once = readConfig();
    dropWebFetchModeMigration.run(workspaceDir);

    expect(readConfig()).toEqual(once);
  });

  test("survives a missing config, malformed JSON, and a sparse config", () => {
    expect(() => dropWebFetchModeMigration.run(workspaceDir)).not.toThrow();

    writeFileSync(join(workspaceDir, "config.json"), "{ not json");
    expect(() => dropWebFetchModeMigration.run(workspaceDir)).not.toThrow();

    writeConfig({});
    expect(() => dropWebFetchModeMigration.run(workspaceDir)).not.toThrow();
    expect(readConfig()).toEqual({});
  });
});
