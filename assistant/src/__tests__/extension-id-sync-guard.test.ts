/**
 * Sync guard: the dev placeholder chrome extension id is referenced
 * from three coupled files that MUST be updated in lockstep:
 *
 *   - assistant/src/runtime/routes/browser-extension-pair-routes.ts
 *     (`ALLOWED_EXTENSION_ORIGINS`)
 *   - clients/chrome-extension-native-host/src/index.ts
 *     (`ALLOWED_EXTENSION_IDS`)
 *   - clients/macos/vellum-assistant/App/AppDelegate+NativeMessaging.swift
 *     (`ChromeExtensionAllowlist.devPlaceholderId`)
 *
 * If any single file is updated without the other two, the self-hosted
 * pair flow breaks silently: the native host rejects the extension
 * origin, the assistant's pair route rejects the request, or the macOS
 * installer writes a stale `allowed_origins` entry to the native
 * messaging manifest.
 *
 * Before releasing the extension publicly, all three references must
 * flip from the dev placeholder (`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`) to
 * the real production id at the same time. This test fails the moment
 * any single reference drifts out of sync, forcing the update to span
 * all three files (and catches accidental divergence between them).
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "bun:test";

const repoRoot = resolve(__dirname, "..", "..", "..");

const COUPLED_FILES: ReadonlyArray<string> = [
  "assistant/src/runtime/routes/browser-extension-pair-routes.ts",
  "clients/chrome-extension-native-host/src/index.ts",
  "clients/macos/vellum-assistant/App/AppDelegate+NativeMessaging.swift",
];

/**
 * The shared dev placeholder extension id. Must match the literal
 * embedded in each of the coupled files above.
 */
const DEV_PLACEHOLDER_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("dev extension ID sync guard", () => {
  test("all three coupled files reference the same dev placeholder id", () => {
    const mismatches: Array<{ file: string; reason: string }> = [];

    for (const relPath of COUPLED_FILES) {
      const absPath = join(repoRoot, relPath);
      let content: string;
      try {
        content = readFileSync(absPath, "utf8");
      } catch (err) {
        mismatches.push({
          file: relPath,
          reason: `could not read: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        continue;
      }
      if (!content.includes(DEV_PLACEHOLDER_ID)) {
        mismatches.push({
          file: relPath,
          reason: `does not contain the dev placeholder id '${DEV_PLACEHOLDER_ID}'`,
        });
      }
    }

    if (mismatches.length > 0) {
      const lines = mismatches
        .map((m) => `  - ${m.file}: ${m.reason}`)
        .join("\n");
      throw new Error(
        `Dev chrome extension id sync guard failed. All of ${JSON.stringify(
          COUPLED_FILES,
        )} must contain the shared id '${DEV_PLACEHOLDER_ID}':\n${lines}\n\n` +
          `If you are rotating to the production extension id, update all three files ` +
          `AND update DEV_PLACEHOLDER_ID in this test at the same time.`,
      );
    }
  });

  test("the shared id is referenced at least once in each file (not just in a comment)", () => {
    // Stronger assertion: make sure the id appears as part of a string
    // literal (not purely in a stale comment). We look for common
    // string-literal quoting markers adjacent to the id.
    const quotingRegexes: ReadonlyArray<RegExp> = [
      new RegExp(`"${DEV_PLACEHOLDER_ID}"`),
      new RegExp(`'${DEV_PLACEHOLDER_ID}'`),
      new RegExp(`\`${DEV_PLACEHOLDER_ID}\``),
      // Allow it to appear inside a chrome-extension URL literal too.
      new RegExp(`"chrome-extension://${DEV_PLACEHOLDER_ID}/"`),
      new RegExp(`'chrome-extension://${DEV_PLACEHOLDER_ID}/'`),
    ];

    const missing: string[] = [];
    for (const relPath of COUPLED_FILES) {
      const absPath = join(repoRoot, relPath);
      const content = readFileSync(absPath, "utf8");
      const hasStringLiteral = quotingRegexes.some((re) => re.test(content));
      if (!hasStringLiteral) {
        missing.push(relPath);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `The following files reference the dev placeholder id only in ` +
          `comments — it should appear as a live string literal ` +
          `(the runtime allowlist entry), not just in documentation: ` +
          `${JSON.stringify(missing)}`,
      );
    }
  });
});
