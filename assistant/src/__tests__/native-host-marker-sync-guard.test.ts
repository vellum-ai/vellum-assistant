/**
 * Sync guard: the `NATIVE_HOST_MARKER_HEADER` and
 * `NATIVE_HOST_MARKER_VALUE` constants are referenced from two coupled
 * files that MUST stay in lockstep:
 *
 *   - assistant/src/runtime/routes/browser-extension-pair-routes.ts
 *     (the runtime side that rejects unmarked pair requests with 403)
 *   - clients/chrome-extension-native-host/src/index.ts
 *     (the native messaging helper that stamps the marker on every
 *     pair POST before forwarding to the assistant)
 *
 * If either side drifts (typo in the header name, or a different
 * value), the pair flow silently breaks end-to-end: the native host
 * sends an unrecognizable header, the runtime rejects the request as
 * if it came from a drive-by webpage, and the extension never gets a
 * token.
 *
 * This guard reads the raw source text of both files at test time and
 * uses regexes to extract the literal string values of each constant.
 * It deliberately does NOT `import` the constants — the whole point is
 * to catch the physical file divergence that an import-based test
 * would paper over (a typo'd export still type-checks if both files
 * are updated independently but inconsistently).
 *
 * Modeled on `extension-id-sync-guard.test.ts`.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const repoRoot = resolve(__dirname, "..", "..", "..");

const ASSISTANT_PAIR_ROUTE_PATH =
  "assistant/src/runtime/routes/browser-extension-pair-routes.ts";
const NATIVE_HOST_INDEX_PATH =
  "clients/chrome-extension-native-host/src/index.ts";

/**
 * Extract the string literal value of an exported const from raw
 * TypeScript source text. Accepts both single- and double-quoted
 * forms and is permissive about whitespace so minor formatter changes
 * don't break the guard.
 *
 * Returns the literal string (without quotes) or `null` if the export
 * cannot be found.
 */
function extractExportedConstString(
  source: string,
  constName: string,
): string | null {
  // Matches: export const FOO = "bar";  (also ' and whitespace
  // variations). The value group stops at the next matching quote.
  const re = new RegExp(
    `export\\s+const\\s+${constName}\\s*=\\s*(['"])([^'"]*)\\1`,
  );
  const match = source.match(re);
  if (!match) return null;
  return match[2] ?? null;
}

describe("native-host marker sync guard", () => {
  test("NATIVE_HOST_MARKER_HEADER matches across runtime route and native host", () => {
    const assistantSource = readFileSync(
      join(repoRoot, ASSISTANT_PAIR_ROUTE_PATH),
      "utf8",
    );
    const nativeHostSource = readFileSync(
      join(repoRoot, NATIVE_HOST_INDEX_PATH),
      "utf8",
    );

    const assistantHeader = extractExportedConstString(
      assistantSource,
      "NATIVE_HOST_MARKER_HEADER",
    );
    const nativeHostHeader = extractExportedConstString(
      nativeHostSource,
      "NATIVE_HOST_MARKER_HEADER",
    );

    expect(assistantHeader).not.toBeNull();
    expect(nativeHostHeader).not.toBeNull();
    // Also require a non-empty value so an accidental `""` in either
    // file trips the guard.
    expect(assistantHeader!.length).toBeGreaterThan(0);
    expect(nativeHostHeader!.length).toBeGreaterThan(0);

    if (assistantHeader !== nativeHostHeader) {
      throw new Error(
        `NATIVE_HOST_MARKER_HEADER drift detected:\n` +
          `  ${ASSISTANT_PAIR_ROUTE_PATH}: ${JSON.stringify(
            assistantHeader,
          )}\n` +
          `  ${NATIVE_HOST_INDEX_PATH}: ${JSON.stringify(nativeHostHeader)}\n\n` +
          `Both files must declare the same header name or pairing ` +
          `silently breaks (the runtime rejects the native host's ` +
          `requests as unmarked drive-by browser fetches).`,
      );
    }
  });

  test("NATIVE_HOST_MARKER_VALUE matches across runtime route and native host", () => {
    const assistantSource = readFileSync(
      join(repoRoot, ASSISTANT_PAIR_ROUTE_PATH),
      "utf8",
    );
    const nativeHostSource = readFileSync(
      join(repoRoot, NATIVE_HOST_INDEX_PATH),
      "utf8",
    );

    const assistantValue = extractExportedConstString(
      assistantSource,
      "NATIVE_HOST_MARKER_VALUE",
    );
    const nativeHostValue = extractExportedConstString(
      nativeHostSource,
      "NATIVE_HOST_MARKER_VALUE",
    );

    expect(assistantValue).not.toBeNull();
    expect(nativeHostValue).not.toBeNull();
    expect(assistantValue!.length).toBeGreaterThan(0);
    expect(nativeHostValue!.length).toBeGreaterThan(0);

    if (assistantValue !== nativeHostValue) {
      throw new Error(
        `NATIVE_HOST_MARKER_VALUE drift detected:\n` +
          `  ${ASSISTANT_PAIR_ROUTE_PATH}: ${JSON.stringify(
            assistantValue,
          )}\n` +
          `  ${NATIVE_HOST_INDEX_PATH}: ${JSON.stringify(nativeHostValue)}\n\n` +
          `Both files must declare the same marker value or pairing ` +
          `silently breaks (the runtime rejects the native host's ` +
          `requests as unmarked drive-by browser fetches).`,
      );
    }
  });

  test("extractExportedConstString helper handles both quote styles", () => {
    // Smoke-test the parser helper itself so a regression in the
    // regex can't silently mask a real drift in the coupled files.
    expect(
      extractExportedConstString(`export const FOO = "hello";`, "FOO"),
    ).toBe("hello");
    expect(
      extractExportedConstString(`export const FOO = 'hello';`, "FOO"),
    ).toBe("hello");
    expect(
      extractExportedConstString(`export  const   FOO   =   "spaced";`, "FOO"),
    ).toBe("spaced");
    expect(
      extractExportedConstString(`export const OTHER = "x";`, "FOO"),
    ).toBeNull();
  });
});
