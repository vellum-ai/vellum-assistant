import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

/**
 * Guard tests for the canonical trust-context model.
 *
 * These tests prevent reintroduction of removed compatibility patterns
 * by scanning source files for type invariants:
 *
 *  (a) guardianPrincipalId in TrustContext must be `?: string`
 *      (optional string), NOT `string | null`.
 *  (b) trustClass in ToolContext must be a required field (no `?`).
 *  (c) The channel retry sweep parser must not reference `actorRole`.
 *  (d) guardianPrincipalId in GuardianBinding must be `string | null` —
 *      a gateway guardian row with no principal surfaces as UNRESOLVED
 *      (null) and is never coerced to a present-but-empty "" (LUM-2665).
 */

const srcDir = join(import.meta.dir, "..");

describe("trust-context guards", () => {
  // -----------------------------------------------------------------------
  // (a) No `string | null` for guardianPrincipalId in runtime types
  // -----------------------------------------------------------------------

  it("guardianPrincipalId is not typed as string | null in TrustContext", () => {
    const source = readFileSync(
      join(srcDir, "daemon", "trust-context.ts"),
      "utf-8",
    );

    // Extract the TrustContext interface block
    const ifaceStart = source.indexOf("export interface TrustContext");
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
      "Expected to find guardianPrincipalId in TrustContext",
    ).toBeDefined();

    expect(
      principalLine!.includes("string | null") ||
        principalLine!.includes("null | string"),
      "guardianPrincipalId must not be typed as nullable in TrustContext. " +
        "Use `guardianPrincipalId?: string` (optional, non-nullable) instead. " +
        `Found: "${principalLine!.trim()}"`,
    ).toBe(false);

    // The field must remain optional (has `?`) — channels where no guardian
    // principal exists should be able to omit it.
    expect(
      /guardianPrincipalId\s*\?/.test(principalLine!),
      "guardianPrincipalId must remain optional (`?:`) in TrustContext. " +
        "Channels without a guardian principal need to omit this field. " +
        `Found: "${principalLine!.trim()}"`,
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // (b) trustClass is required in ToolContext
  // -----------------------------------------------------------------------

  it("trustClass is a required field in ToolContext", () => {
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

    const trustLine = block.split("\n").find((l) => l.includes("trustClass"));
    expect(
      trustLine,
      "Expected to find trustClass in ToolContext",
    ).toBeDefined();

    // The field must NOT have a `?` before the colon — it must be required.
    expect(
      /trustClass\s*\?/.test(trustLine!),
      "trustClass must be a required field in ToolContext (no `?`). " +
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

    // The parseTrustRuntimeContext function must use strict trustClass
    // parsing only — no legacy actorRole fallback.
    const parserStart = source.indexOf("function parseTrustRuntimeContext");
    expect(parserStart).toBeGreaterThan(-1);

    // Find the end of the function (next function-level declaration or EOF)
    const parserBody = source.slice(parserStart);
    const nextFn = parserBody.indexOf("\nexport ", 1);
    const parserSource = nextFn > 0 ? parserBody.slice(0, nextFn) : parserBody;

    expect(
      parserSource.includes("actorRole"),
      "parseTrustRuntimeContext must not reference `actorRole`. " +
        "The retry sweep uses strict `trustClass` parsing — no legacy actorRole fallback.",
    ).toBe(false);
  });

  // -----------------------------------------------------------------------
  // (d) Retry sweep never passes undefined trustContext to processMessage
  // -----------------------------------------------------------------------

  it("retry sweep always provides an explicit trustContext (never undefined)", () => {
    const source = readFileSync(
      join(srcDir, "runtime", "channel-retry-sweep.ts"),
      "utf-8",
    );

    // The sweep must synthesize a trust context when trustCtx is absent,
    // so `trustContext` should never be conditionally undefined at the
    // processMessage callsite. Look for the pattern that ensures this:
    // a `const trustContext: TrustContext = parsedTrustContext ?? {`
    // fallback that synthesizes trustClass: 'unknown'.
    expect(
      source.includes('trustClass: "unknown"'),
      "The retry sweep must synthesize an explicit `trustClass: 'unknown'` context " +
        "when trustCtx is absent from stored payloads. This prevents downstream " +
        "defaults from granting implicit guardian trust on replay.",
    ).toBe(true);
  });

  // -----------------------------------------------------------------------
  // (d) guardianPrincipalId is nullable (unresolved-capable) in
  //     GuardianBinding
  // -----------------------------------------------------------------------

  it("guardianPrincipalId is typed as string | null in GuardianBinding, and reads never coerce null to ''", () => {
    const source = readFileSync(
      join(srcDir, "channels", "channel-verification-sessions.ts"),
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

    // Must be `guardianPrincipalId: string | null` — a gateway guardian row
    // with no principal is UNRESOLVED. Callers repair via the vellum anchor
    // or fail closed; a plain `string` type invites `?? ""` coercion, which
    // creates undecidable canonical requests (LUM-2665).
    expect(
      principalLine!.includes("string | null") ||
        principalLine!.includes("null | string"),
      "guardianPrincipalId must be typed `string | null` in GuardianBinding " +
        "so a missing gateway principal surfaces as unresolved. " +
        `Found: "${principalLine!.trim()}"`,
    ).toBe(true);

    // The synthesizing read must never mask a missing principal as "".
    const serviceSource = readFileSync(
      join(srcDir, "runtime", "channel-verification-service.ts"),
      "utf-8",
    );
    expect(
      serviceSource.includes('principalId ?? ""'),
      "getGuardianBinding must not coerce a missing gateway principal to " +
        '"" — surface null and let callers repair or fail closed.',
    ).toBe(false);
  });
});
