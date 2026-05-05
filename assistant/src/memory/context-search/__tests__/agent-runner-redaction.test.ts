/**
 * Unit tests for workspace-evidence secret redaction in the agentic recall
 * flow (ATL-320).
 *
 * `redactWorkspaceEvidence` scrubs secrets from workspace-sourced evidence
 * excerpts before they are serialised into the prompt that is sent to the
 * external recall LLM provider. Memory/PKB/conversation evidence is left
 * untouched — those sources contain intentionally stored user content.
 */

import { describe, expect, test } from "bun:test";

import { redactWorkspaceEvidence } from "../agent-runner.js";
import type { RecallEvidence } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvidence(
  overrides: Partial<RecallEvidence> & Pick<RecallEvidence, "source">,
): RecallEvidence {
  return {
    id: "ev-1",
    title: "test-file.ts",
    locator: "workspace://test-file.ts",
    excerpt: "some content",
    score: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Anthropic key pattern requires sk-ant- + 80+ chars; use a realistic length.
const ANTHROPIC_KEY = "sk-ant-api03-" + "A1b2C3d4E5f6G7h8I9j0".repeat(5);
// Generic secret assignment — caught by the Generic Secret Assignment pattern.
// Using a generic form avoids GitHub push-protection false-positives on Stripe
// or other vendor-prefix patterns while still exercising the redaction path.
const GENERIC_SECRET_EXCERPT = `api_key="a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"`;

describe("redactWorkspaceEvidence", () => {
  test("redacts known-prefix secrets (Anthropic key) from workspace excerpts", () => {
    const [result] = redactWorkspaceEvidence([
      makeEvidence({
        source: "workspace",
        excerpt: `The API key is ${ANTHROPIC_KEY}`,
      }),
    ]);

    expect(result.excerpt).not.toContain(ANTHROPIC_KEY);
    expect(result.excerpt).toContain("<redacted");
  });

  test("redacts generic secret assignments from workspace excerpts", () => {
    const [result] = redactWorkspaceEvidence([
      makeEvidence({ source: "workspace", excerpt: GENERIC_SECRET_EXCERPT }),
    ]);

    expect(result.excerpt).not.toBe(GENERIC_SECRET_EXCERPT);
    expect(result.excerpt).toContain("<redacted");
  });

  test("does NOT modify non-secret workspace excerpts", () => {
    const safeContent = "This is a normal comment explaining the architecture.";
    const original = makeEvidence({ source: "workspace", excerpt: safeContent });
    const [result] = redactWorkspaceEvidence([original]);

    expect(result.excerpt).toBe(safeContent);
    // No copy made when nothing changed — same reference
    expect(result).toBe(original);
  });

  test("does NOT redact non-workspace sources", () => {
    // Memory/PKB/conversation evidence is intentionally stored user content —
    // redacting it would break recall for things the user deliberately noted.
    const secretLike = "token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.abc";

    for (const source of ["memory", "pkb", "conversations"] as const) {
      const original = makeEvidence({ source, excerpt: secretLike });
      const [result] = redactWorkspaceEvidence([original]);

      expect(result.excerpt).toBe(secretLike);
      expect(result).toBe(original); // Same reference, untouched
    }
  });

  test("redacts multiple secrets across multiple workspace evidence items", () => {
    const results = redactWorkspaceEvidence([
      makeEvidence({ id: "ev-1", source: "workspace", excerpt: `key=${ANTHROPIC_KEY}` }),
      makeEvidence({ id: "ev-2", source: "workspace", excerpt: GENERIC_SECRET_EXCERPT }),
    ]);

    expect(results[0].excerpt).not.toContain(ANTHROPIC_KEY);
    expect(results[1].excerpt).not.toBe(GENERIC_SECRET_EXCERPT);
    expect(results[0].excerpt).toContain("<redacted");
    expect(results[1].excerpt).toContain("<redacted");
  });

  test("does not mutate the original evidence objects", () => {
    const secret = ANTHROPIC_KEY;
    const original = makeEvidence({ source: "workspace", excerpt: `key=${secret}` });
    const originalExcerpt = original.excerpt;

    redactWorkspaceEvidence([original]);

    expect(original.excerpt).toBe(originalExcerpt); // Original unchanged
  });

  test("handles mixed sources in one batch correctly", () => {
    const secret = ANTHROPIC_KEY;
    const wsItem = makeEvidence({ id: "ev-ws", source: "workspace", excerpt: `key=${secret}` });
    const memItem = makeEvidence({ id: "ev-mem", source: "memory", excerpt: `key=${secret}` });

    const [wsResult, memResult] = redactWorkspaceEvidence([wsItem, memItem]);

    expect(wsResult.excerpt).not.toContain(secret);
    expect(memResult.excerpt).toContain(secret); // Memory untouched
  });
});
