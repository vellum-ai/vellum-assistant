import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { invalidateConfigCache, loadRawConfig } from "../config/loader.js";
import {
  classifySlash,
  resolveSlash,
  type SlashContext,
} from "../daemon/conversation-slash.js";
import { getWorkspaceConfigPath } from "../util/platform.js";

function makeSlashContext(overrides: Partial<SlashContext> = {}): SlashContext {
  return {
    messageCount: 4,
    inputTokens: 1024,
    outputTokens: 256,
    maxInputTokens: 200000,
    model: "claude-opus-4-6",
    provider: "anthropic",
    estimatedCost: 0.03,
    ...overrides,
  };
}

async function resolveCommandsLines(context?: SlashContext): Promise<string[]> {
  const result = await resolveSlash("/commands", context);
  expect(result.kind).toBe("unknown");
  if (result.kind !== "unknown") {
    throw new Error("Expected /commands to resolve to kind=unknown");
  }
  return result.message.split("\n");
}

describe("resolveSlash /commands interface-aware help", () => {
  test("renders desktop command help for macOS", async () => {
    const lines = await resolveCommandsLines(
      makeSlashContext({ userMessageInterface: "macos" }),
    );
    expect(lines).toEqual([
      "/commands — List all available commands",
      "/compact — Force context compaction immediately",
      "/clean — Strip injected runtime context and reset memory injection state (no summarization)",
      "/context — Show conversation context usage",
      "/model — List or switch inference profile",
      "/models — List all available models",
      "/status — Show conversation status and context usage",
      "/btw — Ask a side question while the assistant is working",
      "/fork — Fork the current conversation into a new branch",
    ]);
  });

  test("renders iOS command help with /fork", async () => {
    const lines = await resolveCommandsLines(
      makeSlashContext({ userMessageInterface: "ios" }),
    );
    expect(lines).toEqual([
      "/commands — List all available commands",
      "/compact — Force context compaction immediately",
      "/clean — Strip injected runtime context and reset memory injection state (no summarization)",
      "/context — Show conversation context usage",
      "/model — List or switch inference profile",
      "/models — List all available models",
      "/status — Show conversation status and context usage",
      "/btw — Ask a side question while the assistant is working",
      "/fork — Fork the current conversation into a new branch",
    ]);
  });

  test("renders explicit cli command help", async () => {
    const lines = await resolveCommandsLines(
      makeSlashContext({ userMessageInterface: "cli" }),
    );
    expect(lines).toEqual([
      "/commands — List all available commands",
      "/compact — Force context compaction immediately",
      "/clean — Strip injected runtime context and reset memory injection state (no summarization)",
      "/context — Show conversation context usage",
      "/model — List or switch inference profile",
      "/models — List all available models",
      "/status — Show conversation status and context usage",
      "/btw — Ask a side question while the assistant is working",
    ]);
  });

  test("orders fallback help consistently when no interface is provided", async () => {
    const lines = await resolveCommandsLines(makeSlashContext());
    expect(lines).toEqual([
      "/commands — List all available commands",
      "/compact — Force context compaction immediately",
      "/clean — Strip injected runtime context and reset memory injection state (no summarization)",
      "/context — Show conversation context usage",
      "/model — List or switch inference profile",
      "/models — List all available models",
      "/status — Show conversation status and context usage",
    ]);
  });

  test("keeps context-free fallback without /status", async () => {
    const lines = await resolveCommandsLines();
    expect(lines).toEqual([
      "/commands — List all available commands",
      "/compact — Force context compaction immediately",
      "/clean — Strip injected runtime context and reset memory injection state (no summarization)",
      "/model — List or switch inference profile",
      "/models — List all available models",
    ]);
  });
});

describe("resolveSlash command contract", () => {
  test("/context reports the resolved context budget", async () => {
    const result = await resolveSlash(
      "/context",
      makeSlashContext({ inputTokens: 75_000, maxInputTokens: 150_000 }),
    );
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") {
      throw new Error("Expected /context to resolve to kind=unknown");
    }
    expect(result.message).toContain("50%");
    expect(result.message).toContain("75,000 / 150,000 tokens");
  });

  test("keeps unsupported slash forms as passthrough", async () => {
    const slashForms = [
      "/commands foo",
      "/context foo",
      "/models foo",
      "/status foo",
      "/btw",
    ];

    for (const input of slashForms) {
      const result = await resolveSlash(
        input,
        makeSlashContext({ userMessageInterface: "macos" }),
      );
      expect(result).toEqual({ kind: "passthrough", content: input });
    }
  });
});

describe("resolveSlash /compact", () => {
  test("plain /compact resolves to kind=compact", async () => {
    const result = await resolveSlash("/compact");
    expect(result).toEqual({ kind: "compact" });
  });

  test("/compact rejects arguments with usage hint", async () => {
    const result = await resolveSlash("/compact 30000");
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") throw new Error("expected unknown");
    expect(result.message).toContain("does not take arguments");
    expect(result.message).toContain("/compact");
  });
});

describe("resolveSlash /clean", () => {
  test("plain /clean resolves to kind=clean", async () => {
    const result = await resolveSlash("/clean");
    expect(result).toEqual({ kind: "clean" });
  });

  test("/clean tolerates surrounding whitespace", async () => {
    const result = await resolveSlash("  /clean  ");
    expect(result).toEqual({ kind: "clean" });
  });

  test("/clean is case-insensitive", async () => {
    const result = await resolveSlash("/CLEAN");
    expect(result).toEqual({ kind: "clean" });
  });

  test("/clean rejects arguments with usage hint", async () => {
    const result = await resolveSlash("/clean now");
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") throw new Error("expected unknown");
    expect(result.message).toContain("/clean");
    expect(result.message).toContain("does not take arguments");
  });
});

describe("classifySlash is a pure classifier matching resolveSlash kinds", () => {
  // Lookahead in `buildPassthroughBatch` must not run `resolveSlash`'s side
  // effects. The pure classifier is synchronous, takes no side-effecting
  // dependencies, and must agree with resolveSlash's `kind`.
  const cases: Array<{
    input: string;
    kind: "passthrough" | "compact" | "clean" | "unknown";
  }> = [
    { input: "/models", kind: "unknown" },
    { input: "/context", kind: "unknown" },
    { input: "/status", kind: "unknown" },
    { input: "/commands", kind: "unknown" },
    { input: "/compact", kind: "compact" },
    { input: "/compact 30000", kind: "unknown" },
    { input: "/compact 30k", kind: "unknown" },
    { input: "/compact 1.5M", kind: "unknown" },
    { input: "/compact bogus", kind: "unknown" },
    { input: "/clean", kind: "clean" },
    { input: "  /clean  ", kind: "clean" },
    { input: "/clean foo", kind: "unknown" },
    { input: "/model", kind: "unknown" },
    { input: "/model foo", kind: "unknown" },
    { input: "/opus", kind: "unknown" },
    { input: "hello", kind: "passthrough" },
    { input: "  /compact  ", kind: "compact" },
    { input: "  /compact 50k  ", kind: "unknown" },
    { input: "/models foo", kind: "passthrough" },
  ];

  for (const { input, kind } of cases) {
    test(`classifies ${JSON.stringify(input)} as ${kind}`, async () => {
      expect(classifySlash(input)).toBe(kind);
      const resolved = await resolveSlash(
        input,
        makeSlashContext({ userMessageInterface: "macos" }),
      );
      expect(resolved.kind).toBe(kind);
    });
  }
});

// ── /model — inference profile switcher ────────────────────────────

function writeFixtureConfig(config: Record<string, unknown>): void {
  writeFileSync(getWorkspaceConfigPath(), JSON.stringify(config), "utf-8");
  invalidateConfigCache();
}

describe("resolveSlash /model — inference profile switcher", () => {
  beforeEach(() => {
    writeFixtureConfig({
      llm: {
        profiles: {
          balanced: {
            label: "Balanced",
            description: "Default mix of speed and quality",
          },
          "cost-optimized": {
            label: "Cost-optimized",
            description: "Cheaper models, slower",
          },
          "short-context": {
            label: "Short context",
            status: "disabled",
          },
        },
        profileOrder: ["balanced", "cost-optimized", "short-context"],
        activeProfile: "balanced",
      },
    });
  });

  afterEach(() => {
    invalidateConfigCache();
  });

  test("`/model` lists profiles with current marker, status, and description", async () => {
    const result = await resolveSlash("/model");
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") throw new Error("expected unknown kind");
    expect(result.message).toContain("Inference profiles:");
    expect(result.message).toContain(
      "`balanced` (Balanced) **[current]** — Default mix of speed and quality",
    );
    expect(result.message).toContain(
      "`cost-optimized` (Cost-optimized) — Cheaper models, slower",
    );
    expect(result.message).toContain(
      "`short-context` (Short context) *(disabled)*",
    );
    expect(result.message).toContain("Switch with `/model <name>`.");
  });

  test("`/model <name>` switches the active profile and writes config to disk", async () => {
    const result = await resolveSlash("/model cost-optimized");
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") throw new Error("expected unknown kind");
    expect(result.message).toBe(
      "Switched to profile `cost-optimized` (Cost-optimized).",
    );

    const persisted = loadRawConfig() as {
      llm?: { activeProfile?: string };
    };
    expect(persisted.llm?.activeProfile).toBe("cost-optimized");
  });

  test("`/model <unknown>` returns an error with available profile names", async () => {
    const result = await resolveSlash("/model gemini");
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") throw new Error("expected unknown kind");
    expect(result.message).toContain("Profile `gemini` not found.");
    expect(result.message).toContain("`balanced`");
    expect(result.message).toContain("`cost-optimized`");
  });

  test("`/model <disabled>` refuses to switch and points at Settings", async () => {
    const result = await resolveSlash("/model short-context");
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") throw new Error("expected unknown kind");
    expect(result.message).toBe(
      "Profile `short-context` is disabled. Enable it in **Settings → Models & Services** first.",
    );
    // Disk should NOT have been written.
    const persisted = loadRawConfig() as {
      llm?: { activeProfile?: string };
    };
    expect(persisted.llm?.activeProfile).toBe("balanced");
  });

  test("`/model <current>` is a no-op with a friendly message", async () => {
    const result = await resolveSlash("/model balanced");
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") throw new Error("expected unknown kind");
    expect(result.message).toBe("Already using profile `balanced` (Balanced).");
  });

  test("`/model` with no workspace profiles lists the code-catalog defaults", async () => {
    writeFixtureConfig({
      llm: { profiles: {}, profileOrder: [] },
    });
    const result = await resolveSlash("/model");
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") throw new Error("expected unknown kind");
    expect(result.message).toContain("Inference profiles:");
    expect(result.message).toContain("`balanced`");
    expect(result.message).toContain("`quality-optimized`");
    expect(result.message).toContain("`cost-optimized`");
  });

  test("`/model <name>` trims surrounding whitespace from the argument", async () => {
    const result = await resolveSlash("/model   cost-optimized  ");
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") throw new Error("expected unknown kind");
    expect(result.message).toBe(
      "Switched to profile `cost-optimized` (Cost-optimized).",
    );
  });

  test("`/models` (plural) is not parsed as a /model invocation", async () => {
    // /models is a separate command handled elsewhere; this test guards the
    // boundary so we don't accidentally swallow it as a typo'd /model.
    expect(classifySlash("/models")).toBe("unknown");
    // /models foo is passthrough (existing behavior).
    expect(classifySlash("/models foo")).toBe("passthrough");
  });
});
