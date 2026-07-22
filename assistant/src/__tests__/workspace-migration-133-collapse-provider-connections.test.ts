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

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { AssistantConfigSchema } from "../config/schema.js";
import { resolveRoutingIdentity } from "../providers/connection-resolution.js";
import { collapseProviderConnectionsMigration } from "../workspace/migrations/133-collapse-provider-connections.js";

let workspaceDir: string;

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

function readLlm(): Record<string, any> {
  return readConfig().llm as Record<string, any>;
}

function run(): void {
  collapseProviderConnectionsMigration.run(workspaceDir);
}

beforeEach(() => {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-133-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("133-collapse-provider-connections migration", () => {
  test("no-op when config.json does not exist", () => {
    run();
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("gracefully handles invalid JSON", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    run();
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("rewrites the legacy managed triple to identity shape", () => {
    // The pre-flip managed shape: concrete upstream + vellum connection on
    // the profile, defaultProvider pinning the vellum connection by name.
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-8" },
        defaultProvider: { provider: "vellum", connectionName: "vellum" },
        profiles: {
          "my-managed": {
            source: "user",
            provider: "anthropic",
            provider_connection: "vellum",
            model: "claude-opus-4-8",
          },
        },
      },
    });
    run();
    const llm = readLlm();
    expect(llm.default).toBeUndefined();
    expect(llm.defaultProvider).toEqual({ provider: "vellum" });
    expect(llm.profiles["my-managed"]).toEqual({
      source: "user",
      provider: "vellum",
      model: "claude-opus-4-8",
    });
  });

  test("rewritten identity entries survive a real schema parse", () => {
    writeConfig({
      llm: {
        profiles: {
          "my-managed": {
            source: "user",
            provider: "fireworks",
            provider_connection: "vellum",
            model: "accounts/fireworks/models/glm-5p2",
          },
        },
      },
    });
    run();
    const parsed = AssistantConfigSchema.safeParse(readConfig());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.llm.profiles?.["my-managed"]?.provider).toBe("vellum");
    }
  });

  test("BYOK personal connections are dropped; provider and model stay", () => {
    writeConfig({
      llm: {
        defaultProvider: {
          provider: "anthropic",
          connectionName: "anthropic-personal",
        },
        profiles: {
          byok: {
            source: "user",
            provider: "anthropic",
            provider_connection: "anthropic-personal",
            model: "claude-opus-4-8",
          },
        },
        callSites: {
          commitMessage: {
            provider: "openai",
            provider_connection: "openai-personal",
            model: "gpt-5.4-mini",
          },
        },
      },
    });
    run();
    const llm = readLlm();
    expect(llm.defaultProvider).toEqual({ provider: "anthropic" });
    expect(llm.profiles.byok).toEqual({
      source: "user",
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
    expect(llm.callSites.commitMessage).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
    });
  });

  test("chatgpt-subscription entries become provider chatgpt for Codex models only", () => {
    writeConfig({
      llm: {
        profiles: {
          codex: {
            source: "user",
            provider: "openai",
            provider_connection: "chatgpt-subscription",
            model: "gpt-5.5",
          },
          "non-codex": {
            source: "user",
            provider: "openai",
            provider_connection: "chatgpt-subscription",
            model: "gpt-5.5-pro",
          },
        },
      },
    });
    run();
    const llm = readLlm();
    expect(llm.profiles.codex).toEqual({
      source: "user",
      provider: "chatgpt",
      model: "gpt-5.5",
    });
    // A non-Codex model on the subscription row cannot become a chatgpt
    // identity (the schema strips incompatible identity pairs on read).
    expect(llm.profiles["non-codex"]).toEqual({
      source: "user",
      provider: "openai",
      model: "gpt-5.5-pro",
    });
  });

  test("a vellum connection with an unknown model keeps its concrete provider", () => {
    writeConfig({
      llm: {
        profiles: {
          stale: {
            source: "user",
            provider: "anthropic",
            provider_connection: "vellum",
            model: "claude-2.1-retired",
          },
        },
      },
    });
    run();
    expect(readLlm().profiles.stale).toEqual({
      source: "user",
      provider: "anthropic",
      model: "claude-2.1-retired",
    });
  });

  test("dangling connection names are dropped", () => {
    writeConfig({
      llm: {
        profiles: {
          orphan: {
            source: "user",
            provider: "openai-compatible",
            provider_connection: "deleted-endpoint",
            model: "local-model",
          },
        },
      },
    });
    run();
    expect(readLlm().profiles.orphan).toEqual({
      source: "user",
      provider: "openai-compatible",
      model: "local-model",
    });
  });

  test("identity entries lose a stale connection stamp and decode routed models", () => {
    writeConfig({
      llm: {
        profiles: {
          stamped: {
            source: "user",
            provider: "vellum",
            provider_connection: "vellum",
            model: "claude-opus-4-8",
          },
          encoded: {
            source: "user",
            provider: "vellum",
            model: "fireworks/accounts/fireworks/models/glm-5p2",
          },
        },
      },
    });
    run();
    const llm = readLlm();
    expect(llm.profiles.stamped).toEqual({
      source: "user",
      provider: "vellum",
      model: "claude-opus-4-8",
    });
    expect(llm.profiles.encoded).toEqual({
      source: "user",
      provider: "vellum",
      model: "accounts/fireworks/models/glm-5p2",
    });
  });

  test("an encoded model on a vellum connection decodes during the rewrite", () => {
    writeConfig({
      llm: {
        profiles: {
          routed: {
            source: "user",
            provider: "fireworks",
            provider_connection: "vellum",
            model: "fireworks/accounts/fireworks/models/minimax-m3",
          },
        },
      },
    });
    run();
    expect(readLlm().profiles.routed).toEqual({
      source: "user",
      provider: "vellum",
      model: "accounts/fireworks/models/minimax-m3",
    });
  });

  test("native slashed model ids pass through undecoded", () => {
    writeConfig({
      llm: {
        profiles: {
          together: {
            source: "user",
            provider: "together",
            provider_connection: "vellum",
            model: "MiniMaxAI/MiniMax-M3",
          },
        },
      },
    });
    run();
    expect(readLlm().profiles.together).toEqual({
      source: "user",
      provider: "vellum",
      model: "MiniMaxAI/MiniMax-M3",
    });
  });

  test("resolution parity: the rewritten shape dispatches to the same target", () => {
    const pre = {
      llm: {
        activeProfile: "my-managed",
        profiles: {
          "my-managed": {
            source: "user" as const,
            provider: "anthropic",
            provider_connection: "vellum",
            model: "claude-opus-4-8",
          },
        },
      },
    };
    writeConfig(pre);
    const preParsed = AssistantConfigSchema.parse(pre);
    const preResolved = resolveCallSiteConfig("mainAgent", preParsed.llm);
    expect(preResolved.provider_connection).toBe("vellum");
    expect(preResolved.provider).toBe("anthropic");

    run();
    const postParsed = AssistantConfigSchema.parse(readConfig());
    const postResolved = resolveCallSiteConfig("mainAgent", postParsed.llm);
    // The identity translation lands on the same connection row with the
    // same upstream the pre-migration shape named explicitly.
    const identity = resolveRoutingIdentity(
      postResolved.provider,
      postResolved.model,
    );
    expect(identity).toEqual({
      connectionName: "vellum",
      expectedProvider: "anthropic",
    });
    expect(postResolved.model).toBe(preResolved.model);
  });

  test("idempotent on an already-migrated config", () => {
    const migrated = {
      llm: {
        defaultProvider: { provider: "vellum" },
        profiles: {
          "my-managed": {
            source: "user",
            provider: "vellum",
            model: "claude-opus-4-8",
          },
          byok: {
            source: "user",
            provider: "anthropic",
            model: "claude-opus-4-8",
          },
        },
      },
    };
    writeConfig(migrated);
    run();
    expect(readConfig()).toEqual(migrated);
    run();
    expect(readConfig()).toEqual(migrated);
  });

  test("touches nothing outside the connection fields", () => {
    writeConfig({
      llm: {
        activeProfile: "my-managed",
        profileOrder: ["my-managed"],
        profiles: {
          "my-managed": {
            source: "user",
            provider: "anthropic",
            provider_connection: "vellum",
            model: "claude-opus-4-8",
            maxTokens: 32000,
            effort: "high",
            thinking: { enabled: true, streamThinking: true },
          },
        },
      },
      workspaceGit: { enabled: true },
    });
    run();
    const config = readConfig();
    expect((config as any).workspaceGit).toEqual({ enabled: true });
    const llm = readLlm();
    expect(llm.activeProfile).toBe("my-managed");
    expect(llm.profileOrder).toEqual(["my-managed"]);
    expect(llm.profiles["my-managed"]).toEqual({
      source: "user",
      provider: "vellum",
      model: "claude-opus-4-8",
      maxTokens: 32000,
      effort: "high",
      thinking: { enabled: true, streamThinking: true },
    });
  });
});
