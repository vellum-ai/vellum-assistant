import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

/**
 * Guard tests for the canonical trust-context model.
 *
 * These tests prevent reintroduction of removed compatibility patterns
 * by scanning source files for type invariants:
 *
 *  (a) guardianPrincipalId in GuardianRuntimeContext must be `?: string`
 *      (optional string), NOT `string | null`.
 *  (b) guardianTrustClass in ToolContext must be a required field (no `?`).
 *  (c) The channel retry sweep parser must not reference `actorRole`.
 *  (d) guardianPrincipalId in GuardianBinding must be `string` (non-null,
 *      non-optional).
 */

const srcDir = join(import.meta.dir, "..");

describe("trust-context guards", () => {
  // -----------------------------------------------------------------------
  // (a) No `string | null` for guardianPrincipalId in runtime types
  // -----------------------------------------------------------------------

  it("guardianPrincipalId is not typed as string | null in GuardianRuntimeContext", () => {
    const source = readFileSync(
      join(srcDir, "daemon", "session-runtime-assembly.ts"),
      "utf-8",
    );

    // Extract the GuardianRuntimeContext interface block
    const ifaceStart = source.indexOf(
      "export interface GuardianRuntimeContext",
    );
    expect(ifaceStart).toBeGreaterThan(-1);

    const blockStart = source.indexOf("{", ifaceStart);
    let braceDepth = 0;
    let blockEnd = blockStart;
    for (let i = blockStart; i < source.length; i++) {
      if (source[i] === "{") braceDepth++;
      if (source[i] === "}") braceDepth--;
      if (braceDepth === 0) {
        blockEnd = i + 1;
        break;
      }
    }
    const block = source.slice(blockStart, blockEnd);

    // guardianPrincipalId should NOT be typed as `string | null`
    const principalLine = block
      .split("\n")
      .find((l) => l.includes("guardianPrincipalId"));
    expect(
      principalLine,
      "Expected to find guardianPrincipalId in GuardianRuntimeContext",
    ).toBeDefined();

    expect(
      principalLine!.includes("string | null") ||
        principalLine!.includes("null | string"),
      "guardianPrincipalId must not be typed as nullable in GuardianRuntimeContext. " +
        "Use `guardianPrincipalId?: string` (optional, non-nullable) instead. " +
        `Found: "${principalLine!.trim()}"`,
    ).toBe(false);

    // The field must remain optional (has `?`) — channels where no guardian
    // principal exists should be able to omit it.
    expect(
      /guardianPrincipalId\s*\?/.test(principalLine!),
      "guardianPrincipalId must remain optional (`?:`) in GuardianRuntimeContext. " +
        "Channels without a guardian principal need to omit this field. " +
        `Found: "${principalLine!.trim()}"`,
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // (b) guardianTrustClass is required in ToolContext
  // -----------------------------------------------------------------------

  it("guardianTrustClass is a required field in ToolContext", () => {
    const source = readFileSync(join(srcDir, "tools", "types.ts"), "utf-8");

    // Extract the ToolContext interface block
    const ifaceStart = source.indexOf("export interface ToolContext");
    expect(ifaceStart).toBeGreaterThan(-1);

    const blockStart = source.indexOf("{", ifaceStart);
    let braceDepth = 0;
    let blockEnd = blockStart;
    for (let i = blockStart; i < source.length; i++) {
      if (source[i] === "{") braceDepth++;
      if (source[i] === "}") braceDepth--;
      if (braceDepth === 0) {
        blockEnd = i + 1;
        break;
      }
    }
    const block = source.slice(blockStart, blockEnd);

    const trustLine = block
      .split("\n")
      .find((l) => l.includes("guardianTrustClass"));
    expect(
      trustLine,
      "Expected to find guardianTrustClass in ToolContext",
    ).toBeDefined();

    // The field must NOT have a `?` before the colon — it must be required.
    expect(
      /guardianTrustClass\s*\?/.test(trustLine!),
      "guardianTrustClass must be a required field in ToolContext (no `?`). " +
        "Explicit trust gates must not be optional — every tool execution " +
        `must carry a trust classification. Found: "${trustLine!.trim()}"`,
    ).toBe(false);
  });

  // -----------------------------------------------------------------------
  // (c) No actorRole fallback in channel retry sweep parser
  // -----------------------------------------------------------------------

  it("channel retry sweep parser does not reference actorRole", () => {
    const source = readFileSync(
      join(srcDir, "runtime", "channel-retry-sweep.ts"),
      "utf-8",
    );

    // The parseGuardianRuntimeContext function must use strict trustClass
    // parsing only — no legacy actorRole fallback.
    const parserStart = source.indexOf("function parseGuardianRuntimeContext");
    expect(parserStart).toBeGreaterThan(-1);

    // Find the end of the function (next function-level declaration or EOF)
    const parserBody = source.slice(parserStart);
    const nextFn = parserBody.indexOf("\nexport ", 1);
    const parserSource = nextFn > 0 ? parserBody.slice(0, nextFn) : parserBody;

    expect(
      parserSource.includes("actorRole"),
      "parseGuardianRuntimeContext must not reference `actorRole`. " +
        "The retry sweep uses strict `trustClass` parsing — no legacy actorRole fallback.",
    ).toBe(false);
  });

  // -----------------------------------------------------------------------
  // (d) Retry sweep never passes undefined guardianContext to processMessage
  // -----------------------------------------------------------------------

  it("retry sweep always provides an explicit guardianContext (never undefined)", () => {
    const source = readFileSync(
      join(srcDir, "runtime", "channel-retry-sweep.ts"),
      "utf-8",
    );

    // The sweep must synthesize a trust context when guardianCtx is absent,
    // so `guardianContext` should never be conditionally undefined at the
    // processMessage callsite. Look for the pattern that ensures this:
    // a `const guardianContext: GuardianRuntimeContext = parsedGuardianContext ?? {`
    // fallback that synthesizes trustClass: 'unknown'.
    expect(
      source.includes("trustClass: 'unknown'"),
      "The retry sweep must synthesize an explicit `trustClass: 'unknown'` context " +
        "when guardianCtx is absent from stored payloads. This prevents downstream " +
        "defaults from granting implicit guardian trust on replay.",
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // (e) guardianPrincipalId is non-null in GuardianBinding
  // -----------------------------------------------------------------------

  it("guardianPrincipalId is typed as string (non-null) in GuardianBinding", () => {
    const source = readFileSync(
      join(srcDir, "memory", "guardian-bindings.ts"),
      "utf-8",
    );

    // Extract the GuardianBinding interface block
    const ifaceStart = source.indexOf("export interface GuardianBinding");
    expect(ifaceStart).toBeGreaterThan(-1);

    const blockStart = source.indexOf("{", ifaceStart);
    let braceDepth = 0;
    let blockEnd = blockStart;
    for (let i = blockStart; i < source.length; i++) {
      if (source[i] === "{") braceDepth++;
      if (source[i] === "}") braceDepth--;
      if (braceDepth === 0) {
        blockEnd = i + 1;
        break;
      }
    }
    const block = source.slice(blockStart, blockEnd);

    const principalLine = block
      .split("\n")
      .find((l) => l.includes("guardianPrincipalId"));
    expect(
      principalLine,
      "Expected to find guardianPrincipalId in GuardianBinding",
    ).toBeDefined();

    // Must be `guardianPrincipalId: string` — not optional, not nullable
    expect(
      principalLine!.includes("string | null") ||
        principalLine!.includes("null | string"),
      "guardianPrincipalId must not be typed as nullable in GuardianBinding. " +
        `Found: "${principalLine!.trim()}"`,
    ).toBe(false);

    expect(
      /guardianPrincipalId\s*\?/.test(principalLine!),
      "guardianPrincipalId must not be optional in GuardianBinding. " +
        `Found: "${principalLine!.trim()}"`,
    ).toBe(false);
  });

  // -----------------------------------------------------------------------
  // (f) TrustClass includes peer_assistant
  // -----------------------------------------------------------------------

  it("TrustClass type includes peer_assistant in actor-trust-resolver", () => {
    const source = readFileSync(
      join(srcDir, "runtime", "actor-trust-resolver.ts"),
      "utf-8",
    );

    const trustTypeLine = source
      .split("\n")
      .find((l) => l.includes("export type TrustClass"));
    expect(
      trustTypeLine,
      "Expected to find TrustClass type definition in actor-trust-resolver.ts",
    ).toBeDefined();

    expect(
      trustTypeLine!.includes("peer_assistant"),
      "TrustClass must include 'peer_assistant' for A2A peer trust classification. " +
        `Found: "${trustTypeLine!.trim()}"`,
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // (g) peer_assistant is treated as untrusted in tool-approval-handler
  // -----------------------------------------------------------------------

  it("isUntrustedGuardianTrustClass handles peer_assistant in tool-approval-handler", () => {
    const source = readFileSync(
      join(srcDir, "tools", "tool-approval-handler.ts"),
      "utf-8",
    );

    // Find the peer_assistant blanket block in checkPreExecutionGates
    expect(
      source.includes("context.guardianTrustClass === 'peer_assistant'"),
      "tool-approval-handler must include a blanket deny gate for peer_assistant actors. " +
        "Peer assistants have zero capabilities by default.",
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // (h) peer_assistant is recognized in channel-retry-sweep parser
  // -----------------------------------------------------------------------

  it("channel-retry-sweep parser recognizes peer_assistant trustClass", () => {
    const source = readFileSync(
      join(srcDir, "runtime", "channel-retry-sweep.ts"),
      "utf-8",
    );

    expect(
      source.includes("'peer_assistant'"),
      "channel-retry-sweep must recognize 'peer_assistant' as a valid trustClass value " +
        "in parseGuardianRuntimeContext.",
    ).toBe(true);
  });
});
