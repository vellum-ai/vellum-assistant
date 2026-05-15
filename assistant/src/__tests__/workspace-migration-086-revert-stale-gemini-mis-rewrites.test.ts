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

import { revertStaleGeminiMisRewritesMigration } from "../workspace/migrations/086-revert-stale-gemini-mis-rewrites.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-086-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

function configPath(): string {
  return join(workspaceDir, "config.json");
}

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("086-revert-stale-gemini-mis-rewrites migration", () => {
  test("registered in WORKSPACE_MIGRATIONS", () => {
    expect(WORKSPACE_MIGRATIONS).toContain(
      revertStaleGeminiMisRewritesMigration,
    );
  });

  test("reverts call-site model when 057 rewrote on non-Gemini default", () => {
    writeConfig({
      llm: {
        default: { provider: "ollama", model: "llama3.2" },
        callSites: {
          recall: { model: "gemini-3-flash-preview" },
        },
      },
    });

    revertStaleGeminiMisRewritesMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: { recall: { model: string } } };
    };
    expect(config.llm.callSites.recall.model).toBe("gemini-3-flash");
  });

  test("reverts latency call-site model when default is openrouter", () => {
    writeConfig({
      llm: {
        default: { provider: "openrouter", model: "x-ai/grok-4" },
        callSites: {
          memoryRetrieval: { model: "gemini-3.1-flash-lite-preview" },
        },
      },
    });

    revertStaleGeminiMisRewritesMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: { memoryRetrieval: { model: string } } };
    };
    expect(config.llm.callSites.memoryRetrieval.model).toBe("gemini-3-flash");
  });

  test("does not revert when default provider is Gemini", () => {
    const before = {
      llm: {
        default: { provider: "gemini", model: "gemini-3-flash-preview" },
        callSites: {
          recall: { model: "gemini-3-flash-preview" },
        },
      },
    };
    writeConfig(before);
    const beforeRaw = readFileSync(configPath(), "utf-8");

    revertStaleGeminiMisRewritesMigration.run(workspaceDir);

    expect(readFileSync(configPath(), "utf-8")).toBe(beforeRaw);
  });

  test("does not revert when fragment has an explicit provider", () => {
    const before = {
      llm: {
        default: { provider: "ollama", model: "llama3.2" },
        callSites: {
          recall: { provider: "gemini", model: "gemini-3-flash-preview" },
        },
      },
    };
    writeConfig(before);
    const beforeRaw = readFileSync(configPath(), "utf-8");

    revertStaleGeminiMisRewritesMigration.run(workspaceDir);

    expect(readFileSync(configPath(), "utf-8")).toBe(beforeRaw);
  });

  test("does not revert when site profile carries Gemini context via catalog", () => {
    const before = {
      llm: {
        default: { provider: "ollama", model: "llama3.2" },
        profiles: {
          custom: { model: "gemini-2.5-pro" },
        },
        callSites: {
          recall: { profile: "custom", model: "gemini-3-flash-preview" },
        },
      },
    };
    writeConfig(before);
    const beforeRaw = readFileSync(configPath(), "utf-8");

    revertStaleGeminiMisRewritesMigration.run(workspaceDir);

    expect(readFileSync(configPath(), "utf-8")).toBe(beforeRaw);
  });

  test("reverts profile fragment when default provider is non-Gemini", () => {
    writeConfig({
      llm: {
        default: { provider: "openrouter", model: "x-ai/grok-4" },
        profiles: {
          custom: { model: "gemini-3-flash-preview" },
        },
      },
    });

    revertStaleGeminiMisRewritesMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { profiles: { custom: { model: string } } };
    };
    expect(config.llm.profiles.custom.model).toBe("gemini-3-flash");
  });

  test("reverts both profile and call-site when call-site references a candidate profile", () => {
    // Regression for ordering bug: if profile reversion ran after call-site
    // evaluation, the call-site would see the profile's pre-revert rewritten
    // model and infer a Gemini context, masking its own need to revert.
    writeConfig({
      llm: {
        default: { provider: "ollama", model: "llama3.2" },
        profiles: {
          custom: { model: "gemini-3-flash-preview" },
        },
        callSites: {
          recall: { profile: "custom", model: "gemini-3-flash-preview" },
        },
      },
    });

    revertStaleGeminiMisRewritesMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: {
        profiles: { custom: { model: string } };
        callSites: { recall: { model: string; profile: string } };
      };
    };
    expect(config.llm.profiles.custom.model).toBe("gemini-3-flash");
    expect(config.llm.callSites.recall.model).toBe("gemini-3-flash");
  });

  test("mainAgent revert uses activeProfile over call-site for context", () => {
    writeConfig({
      llm: {
        default: { provider: "gemini", model: "gemini-3-flash-preview" },
        activeProfile: "ollamaActive",
        profiles: {
          ollamaActive: { provider: "ollama", model: "llama3.2" },
        },
        callSites: {
          mainAgent: { model: "gemini-3-flash-preview" },
        },
      },
    });

    revertStaleGeminiMisRewritesMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: { mainAgent: { model: string } } };
    };
    // For mainAgent the active profile sits above the call-site, so an
    // Ollama active profile dominates the Gemini default and the rewrite
    // must be reverted.
    expect(config.llm.callSites.mainAgent.model).toBe("gemini-3-flash");
  });

  test("non-mainAgent ignores activeProfile when site.profile is Gemini", () => {
    const before = {
      llm: {
        default: { provider: "ollama", model: "llama3.2" },
        activeProfile: "alsoOllama",
        profiles: {
          alsoOllama: { provider: "ollama", model: "llama3.2" },
          geminiProfile: {
            provider: "gemini",
            model: "gemini-3-flash-preview",
          },
        },
        callSites: {
          recall: { profile: "geminiProfile", model: "gemini-3-flash-preview" },
        },
      },
    };
    writeConfig(before);
    const beforeRaw = readFileSync(configPath(), "utf-8");

    revertStaleGeminiMisRewritesMigration.run(workspaceDir);

    expect(readFileSync(configPath(), "utf-8")).toBe(beforeRaw);
  });

  test("no-op when config.json is missing", () => {
    revertStaleGeminiMisRewritesMigration.run(workspaceDir);
    expect(existsSync(configPath())).toBe(false);
  });

  test("no-op on malformed config", () => {
    writeFileSync(configPath(), "{not json");
    revertStaleGeminiMisRewritesMigration.run(workspaceDir);
    expect(readFileSync(configPath(), "utf-8")).toBe("{not json");
  });

  test("idempotent: re-running after revert is a no-op", () => {
    writeConfig({
      llm: {
        default: { provider: "ollama", model: "llama3.2" },
        callSites: {
          recall: { model: "gemini-3-flash-preview" },
        },
      },
    });

    revertStaleGeminiMisRewritesMigration.run(workspaceDir);
    const afterFirst = readFileSync(configPath(), "utf-8");
    revertStaleGeminiMisRewritesMigration.run(workspaceDir);
    expect(readFileSync(configPath(), "utf-8")).toBe(afterFirst);
  });
});
