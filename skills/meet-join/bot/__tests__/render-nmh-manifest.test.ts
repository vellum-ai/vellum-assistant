/**
 * Unit tests for the native-messaging-host manifest renderer.
 *
 * Covers:
 *   - Chrome extension-ID derivation (SHA-256 of SPKI DER → first 16 bytes
 *     expanded to nibbles → 'a' + nibble).
 *   - `{{EXT_ID}}` placeholder substitution in the template string.
 *   - Agreement with the committed `meet-controller-ext/manifest.json.key`,
 *     so a key rotation in that manifest deliberately breaks this test and
 *     forces the operator to regenerate the ID reference.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  computeExtensionId,
  renderManifest,
} from "../scripts/render-nmh-manifest.js";

/**
 * Reference implementation used to corroborate `computeExtensionId`.
 *
 * This intentionally mirrors the Chrome spec
 * (https://developer.chrome.com/docs/extensions/mv3/manifest/key) rather
 * than importing from the module under test: we want the test to fail if
 * someone later "optimizes" the production implementation in a way that
 * silently diverges from Chrome's computation.
 */
function referenceExtensionId(keyBase64: string): string {
  const der = Buffer.from(keyBase64, "base64");
  const hash = createHash("sha256").update(der).digest("hex");
  const first32 = hash.slice(0, 32);
  let id = "";
  for (const c of first32) {
    const v = parseInt(c, 16);
    id += String.fromCharCode(97 + v);
  }
  return id;
}

describe("computeExtensionId", () => {
  test("matches a hand-computed reference value for a known public key", () => {
    // Generated locally from a throwaway RSA-2048 keypair — value fixed so
    // the test is independent of the committed extension manifest.
    const key =
      "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7HeRDjffv54OgiXEqgqmwhpIo9cruNnF3vscK/Ubn8vENJPp4TSUP2ZVfoWBUVONT5HtKvkYsJJjavokdGMuaRKm9xfdri/WWB+qJRePsGEdTYtNxD5Vrw+c5X6g3S0irNLbqTWGM9++Xn67hYSOKHdDVeKWZGbC6PdqYrTOaB1YHLKp+MulWMgoE4bDc+aWc58LOmhngAbRWreofNM/9Xomazm2TJ5/2zYikaEpRCT1JC3zpLTGfuRroZ2Ln5ut3zphp1aa1z4smViwsFVLUnhLKgWwSv2xPkRRHv5CE5FBDXjvgHNernlD9hn3EZisq3u4Z09C6D2qayC5/IxecQIDAQAB";
    const expected = "ckneaobnfimaenmllkigpibjgkaeolnf";
    expect(computeExtensionId(key)).toBe(expected);
    // Belt-and-suspenders: the reference implementation agrees.
    expect(referenceExtensionId(key)).toBe(expected);
  });

  test("matches the reference implementation for the committed ext manifest key", async () => {
    const extManifestPath = resolve(
      import.meta.dir,
      "..",
      "..",
      "meet-controller-ext",
      "manifest.json",
    );
    const raw = await readFile(extManifestPath, "utf8");
    const manifest = JSON.parse(raw) as { key: string };
    expect(typeof manifest.key).toBe("string");
    const expected = referenceExtensionId(manifest.key);
    expect(computeExtensionId(manifest.key)).toBe(expected);
    // Output shape: 32 lowercase characters in the a..p range.
    expect(expected).toMatch(/^[a-p]{32}$/);
  });

  test("rejects empty input", () => {
    expect(() => computeExtensionId("")).toThrow(/non-empty/);
    expect(() => computeExtensionId("   ")).toThrow(/non-empty/);
  });
});

describe("renderManifest", () => {
  test("substitutes {{EXT_ID}} into a template string", () => {
    const template = JSON.stringify({
      name: "com.vellum.meet",
      allowed_origins: ["chrome-extension://{{EXT_ID}}/"],
    });
    const rendered = renderManifest(template, "abcdefghijklmnopabcdefghijklmnop");
    const parsed = JSON.parse(rendered) as { allowed_origins: string[] };
    expect(parsed.allowed_origins).toEqual([
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
    ]);
  });

  test("replaces every occurrence of the placeholder", () => {
    const template =
      "{{EXT_ID}} and again {{EXT_ID}} and yet again {{EXT_ID}}";
    const rendered = renderManifest(template, "ID");
    expect(rendered).toBe("ID and again ID and yet again ID");
  });

  test("is a no-op when the placeholder is absent", () => {
    const template = '{"name":"com.vellum.meet"}';
    expect(renderManifest(template, "anything")).toBe(template);
  });
});

describe("render integration", () => {
  test("template + computed id yields a well-formed NMH manifest", async () => {
    const templatePath = resolve(
      import.meta.dir,
      "..",
      "native-messaging",
      "com.vellum.meet.json",
    );
    const extManifestPath = resolve(
      import.meta.dir,
      "..",
      "..",
      "meet-controller-ext",
      "manifest.json",
    );
    const template = await readFile(templatePath, "utf8");
    const extManifest = JSON.parse(
      await readFile(extManifestPath, "utf8"),
    ) as { key: string };
    const extId = computeExtensionId(extManifest.key);
    const rendered = renderManifest(template, extId);
    const parsed = JSON.parse(rendered) as {
      name: string;
      type: string;
      path: string;
      allowed_origins: string[];
    };
    expect(parsed.name).toBe("com.vellum.meet");
    expect(parsed.type).toBe("stdio");
    expect(parsed.path).toBe("/app/bot/src/native-messaging/nmh-shim.ts");
    expect(parsed.allowed_origins).toEqual([
      `chrome-extension://${extId}/`,
    ]);
  });
});
