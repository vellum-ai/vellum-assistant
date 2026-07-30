import { beforeEach, describe, expect, test } from "bun:test";

import { getConfig } from "../config/loader.js";
import { setConfig } from "./helpers/set-config.js";

// ─── Fixture config ─────────────────────────────────────────────────────────

let mockLlm: Record<string, unknown> = {};

const { resolveSlash } = await import("../daemon/conversation-slash.js");

/**
 * Install the current fixture `llm` config for real. A schema-valid baseline
 * is seeded first so the loader caches a config object; `llm` is then
 * overwritten on that live cached object so fixtures reach the resolver
 * exactly as authored.
 */
function applyConfig(): void {
  setConfig("llm", { profiles: {} });
  const config = getConfig() as { llm: unknown };
  config.llm = mockLlm;
}

beforeEach(() => {
  mockLlm = { profiles: {} };
  applyConfig();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("/model list", () => {
  test("lists the code-catalog defaults", async () => {
    const result = await resolveSlash("/model");
    expect(result.kind).toBe("unknown");
    const message = (result as { message: string }).message;
    expect(message).toContain("`balanced`");
    expect(message).toContain("`quality-optimized`");
    expect(message).toContain("`cost-optimized`");
  });

  test("default profile descriptions follow the default provider's column", async () => {
    // The BYOK and vellum columns carry different description strings for
    // quality-optimized and cost-optimized; the listing must show the column
    // that actually dispatches on this install.
    mockLlm = {
      profiles: {},
      defaultProvider: { provider: "anthropic" },
    };
    applyConfig();

    const message = ((await resolveSlash("/model")) as { message: string })
      .message;
    expect(message).toContain("Best results with the most capable model");
    expect(message).toContain("Fastest responses at lower cost");
    expect(message).not.toContain("(DeepSeek V4 Flash)");
  });

  test("descriptions use the managed column without a default provider", async () => {
    const message = ((await resolveSlash("/model")) as { message: string })
      .message;
    // The quality tier is the column discriminator now that cost-optimized
    // copy is intent-only in both columns (no model names - LUM-2881).
    expect(message).toContain(
      "High-quality results with the most capable model",
    );
    expect(message).toContain("Fastest responses at lower cost");
    expect(message).not.toContain("(DeepSeek V4 Flash)");
  });
});

describe("/model switch", () => {
  test("rejects an unknown profile with the available set", async () => {
    const result = await resolveSlash("/model nope");
    expect(result.kind).toBe("unknown");
    const message = (result as { message: string }).message;
    expect(message).toContain("`nope` not found");
    expect(message).toContain("`balanced`");
  });

  test("validates against the same set under a BYO default provider", async () => {
    mockLlm = {
      profiles: {},
      defaultProvider: { provider: "anthropic" },
    };
    applyConfig();

    const result = await resolveSlash("/model nope");
    expect((result as { message: string }).message).toContain(
      "`nope` not found",
    );
  });
});
