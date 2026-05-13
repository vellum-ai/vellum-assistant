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

import { repairStaleGeminiModelIdsMigration } from "../workspace/migrations/057-repair-stale-gemini-model-ids.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-057-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("057-repair-stale-gemini-model-ids migration", () => {
  test("has correct migration id and is registered", () => {
    expect(repairStaleGeminiModelIdsMigration.id).toBe(
      "057-repair-stale-gemini-model-ids",
    );
    expect(WORKSPACE_MIGRATIONS.map((m) => m.id)).toContain(
      "057-repair-stale-gemini-model-ids",
    );
  });

  test("repairs stale call-site model IDs with site-aware replacements", () => {
    writeConfig({
      llm: {
        callSites: {
          analyzeConversation: {
            model: "gemini-3-flash",
            temperature: 0,
          },
          conversationSummarization: { model: "gemini-3-flash" },
          memoryRetrieval: { model: "gemini-3-flash" },
          recall: {
            model: "gemini-3-flash",
            maxTokens: 4096,
          },
          commitMessage: {
            model: "prefix-gemini-3-flash",
          },
          malformed: "gemini-3-flash",
        },
      },
    });

    repairStaleGeminiModelIdsMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown> | string> };
    };
    expect(config.llm.callSites.analyzeConversation).toEqual({
      model: "gemini-3.1-flash-lite-preview",
      temperature: 0,
    });
    expect(config.llm.callSites.conversationSummarization).toEqual({
      model: "gemini-3.1-flash-lite-preview",
    });
    expect(config.llm.callSites.memoryRetrieval).toEqual({
      model: "gemini-3.1-flash-lite-preview",
    });
    expect(config.llm.callSites.recall).toEqual({
      model: "gemini-3-flash-preview",
      maxTokens: 4096,
    });
    expect(config.llm.callSites.commitMessage).toEqual({
      model: "prefix-gemini-3-flash",
    });
    expect(config.llm.callSites.malformed).toBe("gemini-3-flash");
  });

  test("repairs default and profile model IDs with generic Gemini Flash replacement", () => {
    writeConfig({
      llm: {
        default: {
          provider: "gemini",
          model: "gemini-3-flash",
          maxTokens: 8192,
        },
        profiles: {
          balanced: {
            provider: "gemini",
            model: "gemini-3-flash",
          },
          "cost-optimized": {
            provider: "gemini",
            model: "gemini-3.1-flash-lite-preview",
          },
          malformed: "gemini-3-flash",
        },
      },
    });

    repairStaleGeminiModelIdsMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: {
        default: Record<string, unknown>;
        profiles: Record<string, Record<string, unknown> | string>;
      };
    };
    expect(config.llm.default).toEqual({
      provider: "gemini",
      model: "gemini-3-flash-preview",
      maxTokens: 8192,
    });
    expect(config.llm.profiles.balanced).toEqual({
      provider: "gemini",
      model: "gemini-3-flash-preview",
    });
    expect(config.llm.profiles["cost-optimized"]).toEqual({
      provider: "gemini",
      model: "gemini-3.1-flash-lite-preview",
    });
    expect(config.llm.profiles.malformed).toBe("gemini-3-flash");
  });

  test("preserves unrelated values and does not rewrite substring matches", () => {
    writeConfig({
      model: "gemini-3-flash",
      imageGeneration: {
        model: "gemini-3-flash",
      },
      llm: {
        default: {
          model: "gemini-3-flash-001",
        },
        callSites: {
          analyzeConversation: {
            model: "gemini-3-flash-preview",
          },
        },
        profiles: {
          custom: {
            model: "my-gemini-3-flash",
          },
        },
      },
    });
    const before = readFileSync(configPath(), "utf-8");

    repairStaleGeminiModelIdsMigration.run(workspaceDir);

    expect(readFileSync(configPath(), "utf-8")).toBe(before);
  });

  test("is idempotent after repairing stale model IDs", () => {
    writeConfig({
      llm: {
        default: { model: "gemini-3-flash" },
        callSites: {
          memoryRetrieval: { model: "gemini-3-flash" },
          interactionClassifier: { model: "gemini-3-flash" },
        },
        profiles: {
          balanced: { model: "gemini-3-flash" },
        },
      },
    });

    repairStaleGeminiModelIdsMigration.run(workspaceDir);
    const afterFirst = readFileSync(configPath(), "utf-8");
    repairStaleGeminiModelIdsMigration.run(workspaceDir);
    const afterSecond = readFileSync(configPath(), "utf-8");

    expect(afterSecond).toBe(afterFirst);

    const config = readConfig() as {
      llm: {
        default: { model: string };
        callSites: Record<string, { model: string }>;
        profiles: Record<string, { model: string }>;
      };
    };
    expect(config.llm.default.model).toBe("gemini-3-flash-preview");
    expect(config.llm.callSites.memoryRetrieval.model).toBe(
      "gemini-3.1-flash-lite-preview",
    );
    expect(config.llm.callSites.interactionClassifier.model).toBe(
      "gemini-3-flash-preview",
    );
    expect(config.llm.profiles.balanced.model).toBe("gemini-3-flash-preview");
  });

  test("does not rewrite blocks whose effective provider is not Gemini", () => {
    writeConfig({
      llm: {
        default: {
          provider: "ollama",
          model: "gemini-3-flash",
        },
        callSites: {
          analyzeConversation: {
            provider: "openrouter",
            model: "gemini-3-flash",
          },
          recall: {
            model: "gemini-3-flash",
          },
        },
        profiles: {
          custom: {
            provider: "ollama",
            model: "gemini-3-flash",
          },
        },
      },
    });
    const before = readFileSync(configPath(), "utf-8");

    repairStaleGeminiModelIdsMigration.run(workspaceDir);

    expect(readFileSync(configPath(), "utf-8")).toBe(before);
  });

  test("rewrites call-site/profile blocks without local provider when default is Gemini", () => {
    writeConfig({
      llm: {
        default: { provider: "gemini", model: "gemini-3-flash-preview" },
        callSites: {
          memoryRetrieval: { model: "gemini-3-flash" },
        },
        profiles: {
          balanced: { model: "gemini-3-flash" },
        },
      },
    });

    repairStaleGeminiModelIdsMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: {
        callSites: Record<string, { model: string }>;
        profiles: Record<string, { model: string }>;
      };
    };
    expect(config.llm.callSites.memoryRetrieval.model).toBe(
      "gemini-3.1-flash-lite-preview",
    );
    expect(config.llm.profiles.balanced.model).toBe("gemini-3-flash-preview");
  });

  test("no-ops when config.json is missing or invalid", () => {
    repairStaleGeminiModelIdsMigration.run(workspaceDir);
    expect(existsSync(configPath())).toBe(false);

    writeFileSync(configPath(), "not-valid-json");
    repairStaleGeminiModelIdsMigration.run(workspaceDir);
    expect(readFileSync(configPath(), "utf-8")).toBe("not-valid-json");

    writeFileSync(configPath(), JSON.stringify([1, 2, 3]));
    repairStaleGeminiModelIdsMigration.run(workspaceDir);
    expect(readFileSync(configPath(), "utf-8")).toBe("[1,2,3]");
  });
});
