import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

/**
 * Guard tests for memory provenance gating of peer_assistant actors.
 *
 * These tests scan source files to enforce the Memory Provenance Invariant:
 * peer_assistant actors (A2A peers) must NOT trigger profile extraction,
 * receive memory recall, or receive conflict disclosures. The invariant is
 * enforced at four gate points:
 *
 *   (a) indexer.ts — write gate: only guardian/undefined actors get extraction
 *   (b) session-memory.ts — read gate: only guardian actors get recall/profile
 *   (c) session-lifecycle.ts — history view gate: peer_assistant is untrusted
 *   (d) backfill.ts — backfill gate: only guardian/undefined actors get extraction
 *
 * These guards prevent regression if someone changes the trust gating logic
 * without updating all four gate points.
 */

const srcDir = join(import.meta.dir, "..");

describe("memory provenance A2A guard", () => {
  // -----------------------------------------------------------------------
  // (a) Indexer write gate — peer_assistant excluded from extraction
  // -----------------------------------------------------------------------

  it("indexer isTrustedActor only trusts guardian and undefined provenance", () => {
    const source = readFileSync(
      join(srcDir, "memory", "indexer.ts"),
      "utf-8",
    );

    // The indexer must define isTrustedActor as a whitelist of guardian + undefined.
    // This ensures peer_assistant (and any other trust class) is excluded.
    expect(
      source.includes("provenanceTrustClass === 'guardian'"),
      "indexer.ts must check for guardian provenance in isTrustedActor. " +
        "Only guardian actors should trigger extraction.",
    ).toBe(true);

    expect(
      source.includes("provenanceTrustClass === undefined"),
      "indexer.ts must check for undefined provenance (legacy/desktop actors) in isTrustedActor.",
    ).toBe(true);

    // The indexer must NOT have peer_assistant in its trusted check
    const trustedLine = source
      .split("\n")
      .find((l) => l.includes("isTrustedActor") && l.includes("="));
    expect(
      trustedLine,
      "Expected to find isTrustedActor assignment in indexer.ts",
    ).toBeDefined();

    expect(
      trustedLine!.includes("peer_assistant"),
      "indexer.ts isTrustedActor must NOT include peer_assistant. " +
        "A2A peers must not trigger profile extraction. " +
        `Found: "${trustedLine!.trim()}"`,
    ).toBe(false);
  });

  it("indexer provenanceTrustClass type includes peer_assistant", () => {
    const source = readFileSync(
      join(srcDir, "memory", "indexer.ts"),
      "utf-8",
    );

    // The IndexMessageInput type must include peer_assistant in its
    // provenanceTrustClass union so the compiler enforces coverage.
    expect(
      source.includes("'peer_assistant'"),
      "indexer.ts IndexMessageInput.provenanceTrustClass must include 'peer_assistant' " +
        "in its type union.",
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // (b) Session-memory read gate — peer_assistant excluded from recall
  // -----------------------------------------------------------------------

  it("session-memory isTrustedActor only trusts guardian for recall", () => {
    const source = readFileSync(
      join(srcDir, "daemon", "session-memory.ts"),
      "utf-8",
    );

    // The read gate must check strictly for 'guardian' only.
    const trustedLine = source
      .split("\n")
      .find((l) => l.includes("isTrustedActor") && l.includes("==="));
    expect(
      trustedLine,
      "Expected to find isTrustedActor check in session-memory.ts",
    ).toBeDefined();

    expect(
      trustedLine!.includes("'guardian'"),
      "session-memory.ts isTrustedActor must check for 'guardian'. " +
        `Found: "${trustedLine!.trim()}"`,
    ).toBe(true);

    // Must NOT include peer_assistant as trusted
    expect(
      trustedLine!.includes("peer_assistant"),
      "session-memory.ts isTrustedActor must NOT include 'peer_assistant'. " +
        "A2A peers must not receive memory recall or conflict disclosures. " +
        `Found: "${trustedLine!.trim()}"`,
    ).toBe(false);
  });

  it("session-memory MemoryPrepareContext accepts peer_assistant trust class", () => {
    const source = readFileSync(
      join(srcDir, "daemon", "session-memory.ts"),
      "utf-8",
    );

    // The MemoryPrepareContext interface must include peer_assistant
    // in its guardianTrustClass type.
    expect(
      source.includes("'peer_assistant'"),
      "session-memory.ts MemoryPrepareContext.guardianTrustClass must include " +
        "'peer_assistant' so the compiler enforces coverage.",
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // (c) Session-lifecycle history view gate — peer_assistant is untrusted
  // -----------------------------------------------------------------------

  it("session-lifecycle isUntrustedTrustClass includes peer_assistant", () => {
    const source = readFileSync(
      join(srcDir, "daemon", "session-lifecycle.ts"),
      "utf-8",
    );

    // Find the isUntrustedTrustClass function
    const fnStart = source.indexOf("function isUntrustedTrustClass");
    expect(fnStart).toBeGreaterThan(-1);

    // Extract the function body (until next function or export)
    const fnBody = source.slice(fnStart);
    const nextFn = fnBody.indexOf("\nfunction ", 1);
    const nextExport = fnBody.indexOf("\nexport ", 1);
    const end = Math.min(
      nextFn > 0 ? nextFn : Infinity,
      nextExport > 0 ? nextExport : Infinity,
      fnBody.length,
    );
    const fnSource = fnBody.slice(0, end);

    expect(
      fnSource.includes("'peer_assistant'"),
      "session-lifecycle.ts isUntrustedTrustClass must include 'peer_assistant'. " +
        "A2A peers must be treated as untrusted for history view gating.",
    ).toBe(true);
  });

  it("session-lifecycle filterMessagesForUntrustedActor includes peer_assistant provenance", () => {
    const source = readFileSync(
      join(srcDir, "daemon", "session-lifecycle.ts"),
      "utf-8",
    );

    // Find the filterMessagesForUntrustedActor function
    const fnStart = source.indexOf("function filterMessagesForUntrustedActor");
    expect(fnStart).toBeGreaterThan(-1);

    const fnBody = source.slice(fnStart);
    const nextFn = fnBody.indexOf("\n\n", 1);
    const fnSource = fnBody.slice(0, nextFn > 0 ? nextFn : fnBody.length);

    expect(
      fnSource.includes("'peer_assistant'"),
      "session-lifecycle.ts filterMessagesForUntrustedActor must include " +
        "'peer_assistant' in provenance filtering.",
    ).toBe(true);
  });

  it("session-lifecycle parseProvenanceTrustClass recognizes peer_assistant", () => {
    const source = readFileSync(
      join(srcDir, "daemon", "session-lifecycle.ts"),
      "utf-8",
    );

    const fnStart = source.indexOf("function parseProvenanceTrustClass");
    expect(fnStart).toBeGreaterThan(-1);

    const fnBody = source.slice(fnStart);
    const nextFn = fnBody.indexOf("\nfunction ", 1);
    const fnSource = fnBody.slice(0, nextFn > 0 ? nextFn : fnBody.length);

    expect(
      fnSource.includes("'peer_assistant'"),
      "session-lifecycle.ts parseProvenanceTrustClass must recognize " +
        "'peer_assistant' as a valid trust class.",
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // (d) Backfill gate — peer_assistant excluded from extraction on backfill
  // -----------------------------------------------------------------------

  it("backfill isTrustedTrustClass only trusts guardian and undefined", () => {
    const source = readFileSync(
      join(srcDir, "memory", "job-handlers", "backfill.ts"),
      "utf-8",
    );

    // The backfill handler must define isTrustedTrustClass the same way
    // as the indexer: guardian + undefined only.
    const trustedFn = source
      .split("\n")
      .find((l) => l.includes("function isTrustedTrustClass"));
    expect(
      trustedFn,
      "Expected to find isTrustedTrustClass function in backfill.ts",
    ).toBeDefined();

    // Extract the function body
    const fnStart = source.indexOf("function isTrustedTrustClass");
    const fnBody = source.slice(fnStart);
    const fnEnd = fnBody.indexOf("}");
    const fnSource = fnBody.slice(0, fnEnd + 1);

    // Must trust guardian
    expect(
      fnSource.includes("'guardian'"),
      "backfill.ts isTrustedTrustClass must check for 'guardian'.",
    ).toBe(true);

    // Must NOT include peer_assistant as trusted
    expect(
      fnSource.includes("'peer_assistant'"),
      "backfill.ts isTrustedTrustClass must NOT include 'peer_assistant'. " +
        "A2A peers must not trigger extraction during backfill.",
    ).toBe(false);
  });

  it("backfill ProvenanceTrustClass type includes peer_assistant", () => {
    const source = readFileSync(
      join(srcDir, "memory", "job-handlers", "backfill.ts"),
      "utf-8",
    );

    expect(
      source.includes("'peer_assistant'"),
      "backfill.ts ProvenanceTrustClass must include 'peer_assistant' " +
        "so the type system tracks A2A peer provenance.",
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // (e) Conversation CRUD schema includes peer_assistant
  // -----------------------------------------------------------------------

  it("conversation-crud provenanceTrustClass schema includes peer_assistant", () => {
    const source = readFileSync(
      join(srcDir, "memory", "conversation-crud.ts"),
      "utf-8",
    );

    expect(
      source.includes("'peer_assistant'"),
      "conversation-crud.ts provenanceTrustClass schema must include 'peer_assistant' " +
        "so A2A peer provenance can be stored and queried.",
    ).toBe(true);
  });
});
