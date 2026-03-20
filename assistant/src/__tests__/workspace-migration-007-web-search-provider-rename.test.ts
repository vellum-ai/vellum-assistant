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

import { webSearchProviderRenameMigration } from "../workspace/migrations/007-web-search-provider-rename.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-007-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("007-web-search-provider-rename migration", () => {
  test("renames anthropic-native to inference-provider-native", () => {
    writeConfig({
      services: {
        inference: {
          mode: "your-own",
          provider: "anthropic",
          model: "claude-opus-4-6",
        },
        "web-search": {
          mode: "your-own",
          provider: "anthropic-native",
        },
      },
    });

    webSearchProviderRenameMigration.run(workspaceDir);

    const config = readConfig();
    const services = config.services as Record<string, Record<string, unknown>>;
    expect(services["web-search"].provider).toBe("inference-provider-native");

    // Other services should be unchanged
    expect(services.inference.provider).toBe("anthropic");
    expect(services.inference.model).toBe("claude-opus-4-6");
  });

  test("no-op when provider is already inference-provider-native", () => {
    const original = {
      services: {
        "web-search": {
          mode: "your-own",
          provider: "inference-provider-native",
        },
      },
    };
    writeConfig(original);

    webSearchProviderRenameMigration.run(workspaceDir);

    const config = readConfig();
    expect(config).toEqual(original);
  });

  test("no-op when provider is a different value (e.g. brave)", () => {
    const original = {
      services: {
        "web-search": {
          mode: "your-own",
          provider: "brave",
        },
      },
    };
    writeConfig(original);

    webSearchProviderRenameMigration.run(workspaceDir);

    const config = readConfig();
    expect(config).toEqual(original);
  });

  test("no-op when provider is perplexity", () => {
    const original = {
      services: {
        "web-search": {
          mode: "your-own",
          provider: "perplexity",
        },
      },
    };
    writeConfig(original);

    webSearchProviderRenameMigration.run(workspaceDir);

    const config = readConfig();
    expect(config).toEqual(original);
  });

  test("no-op when config.json does not exist", () => {
    webSearchProviderRenameMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("no-op when services key is missing", () => {
    const original = { someOtherKey: true };
    writeConfig(original);

    webSearchProviderRenameMigration.run(workspaceDir);

    const config = readConfig();
    expect(config).toEqual(original);
  });

  test("no-op when web-search section is missing", () => {
    const original = {
      services: {
        inference: {
          mode: "your-own",
          provider: "anthropic",
          model: "claude-opus-4-6",
        },
      },
    };
    writeConfig(original);

    webSearchProviderRenameMigration.run(workspaceDir);

    const config = readConfig();
    expect(config).toEqual(original);
  });

  test("idempotency: running migration twice produces same result", () => {
    writeConfig({
      services: {
        "web-search": {
          mode: "your-own",
          provider: "anthropic-native",
        },
      },
    });

    webSearchProviderRenameMigration.run(workspaceDir);
    const afterFirst = readConfig();

    webSearchProviderRenameMigration.run(workspaceDir);
    const afterSecond = readConfig();

    expect(afterSecond).toEqual(afterFirst);
    const services = afterSecond.services as Record<
      string,
      Record<string, unknown>
    >;
    expect(services["web-search"].provider).toBe("inference-provider-native");
  });

  test("gracefully handles invalid JSON in config file", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");

    webSearchProviderRenameMigration.run(workspaceDir);

    // File should be unchanged
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("gracefully handles array config", () => {
    writeFileSync(join(workspaceDir, "config.json"), JSON.stringify([1, 2, 3]));

    webSearchProviderRenameMigration.run(workspaceDir);

    // File should be unchanged
    const raw = JSON.parse(
      readFileSync(join(workspaceDir, "config.json"), "utf-8"),
    );
    expect(raw).toEqual([1, 2, 3]);
  });

  test("gracefully handles services as a non-object value", () => {
    const original = { services: "not-an-object" };
    writeConfig(original);

    webSearchProviderRenameMigration.run(workspaceDir);

    const config = readConfig();
    expect(config).toEqual(original);
  });

  test("gracefully handles web-search as a non-object value", () => {
    const original = {
      services: {
        "web-search": "not-an-object",
      },
    };
    writeConfig(original);

    webSearchProviderRenameMigration.run(workspaceDir);

    const config = readConfig();
    expect(config).toEqual(original);
  });

  test("preserves extra fields in web-search config", () => {
    writeConfig({
      services: {
        "web-search": {
          mode: "your-own",
          provider: "anthropic-native",
          extraField: "should-survive",
        },
      },
    });

    webSearchProviderRenameMigration.run(workspaceDir);

    const config = readConfig();
    const services = config.services as Record<string, Record<string, unknown>>;
    expect(services["web-search"].provider).toBe("inference-provider-native");
    expect(services["web-search"].extraField).toBe("should-survive");
    expect(services["web-search"].mode).toBe("your-own");
  });

  test("preserves other top-level config keys", () => {
    writeConfig({
      someTopLevelKey: "value",
      services: {
        inference: {
          mode: "your-own",
          provider: "openai",
          model: "gpt-4o",
        },
        "web-search": {
          mode: "your-own",
          provider: "anthropic-native",
        },
        "custom-service": {
          foo: "bar",
        },
      },
    });

    webSearchProviderRenameMigration.run(workspaceDir);

    const config = readConfig();
    expect(config.someTopLevelKey).toBe("value");

    const services = config.services as Record<string, Record<string, unknown>>;
    expect(services["web-search"].provider).toBe("inference-provider-native");
    expect(services.inference.provider).toBe("openai");
    expect(services["custom-service"]).toEqual({ foo: "bar" });
  });

  test("gracefully handles services as an array", () => {
    const original = { services: [1, 2, 3] };
    writeConfig(original);

    webSearchProviderRenameMigration.run(workspaceDir);

    const config = readConfig();
    expect(config).toEqual(original);
  });

  test("gracefully handles web-search as an array", () => {
    const original = {
      services: {
        "web-search": [1, 2, 3],
      },
    };
    writeConfig(original);

    webSearchProviderRenameMigration.run(workspaceDir);

    const config = readConfig();
    expect(config).toEqual(original);
  });
});
