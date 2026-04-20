#!/usr/bin/env bun
/**
 * render-nmh-manifest — emit a Chrome native-messaging host manifest with
 * `{{EXT_ID}}` replaced by the extension ID derived from the sibling
 * `meet-controller-ext` package's public key.
 *
 * Invoked at image-build time from `skills/meet-join/bot/Dockerfile` so the
 * rendered file lands at Chrome's well-known search path
 * (`/etc/opt/chrome/native-messaging-hosts/com.vellum.meet.json`) inside the
 * bot image. The Chrome extension's `allowed_origins` entry pins the bot's
 * native host to only accept connections from the extension whose SPKI
 * public-key matches the `key` field committed to
 * `meet-controller-ext/manifest.json`.
 *
 * Entry points:
 *   - CLI: `bun scripts/render-nmh-manifest.ts <output-path> [--ext-manifest <path>]`
 *   - Library: exported `computeExtensionId` and `renderManifest` helpers.
 *
 * The extension-ID math follows Chrome's documented derivation:
 *   https://developer.chrome.com/docs/extensions/mv3/manifest/key
 * Concretely: SHA-256 the DER-encoded SubjectPublicKeyInfo (the base64 body
 * of `manifest.json.key`), take the first 16 bytes of the hash, split each
 * byte into its high and low nibbles, and emit `'a' + nibble` — yielding a
 * 32-character lowercase a-p string.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Default location of the sibling extension's manifest relative to THIS
 * script. Used by the CLI when `--ext-manifest` is not supplied so local
 * dev invocations (outside Docker) work without extra flags.
 */
const DEFAULT_EXT_MANIFEST_PATH = resolve(
  import.meta.dir,
  "..",
  "..",
  "meet-controller-ext",
  "manifest.json",
);

/**
 * Default location of the bot's NMH template relative to THIS script.
 */
const DEFAULT_TEMPLATE_PATH = resolve(
  import.meta.dir,
  "..",
  "native-messaging",
  "com.vellum.meet.json",
);

/**
 * Compute the Chrome extension ID that Chromium will derive from a given
 * base64-encoded SPKI public key. See file header for the algorithm.
 *
 * @throws if `keyBase64` is empty or cannot be base64-decoded into a
 *   non-empty byte sequence.
 */
export function computeExtensionId(keyBase64: string): string {
  if (typeof keyBase64 !== "string" || keyBase64.trim().length === 0) {
    throw new Error("computeExtensionId: keyBase64 must be a non-empty string");
  }
  const der = Buffer.from(keyBase64, "base64");
  if (der.byteLength === 0) {
    throw new Error("computeExtensionId: base64 decode produced zero bytes");
  }
  const hash = createHash("sha256").update(der).digest();
  // Take the first 16 bytes (32 hex chars worth of nibbles) and map each
  // nibble to 'a'..'p' (0 -> 'a', 15 -> 'p').
  let id = "";
  for (let i = 0; i < 16; i += 1) {
    const byte = hash[i]!;
    const hi = (byte >> 4) & 0xf;
    const lo = byte & 0xf;
    id += String.fromCharCode(97 + hi);
    id += String.fromCharCode(97 + lo);
  }
  return id;
}

/**
 * Substitute `{{EXT_ID}}` placeholders in a template string with the given
 * extension ID. Returns the rendered string; does not touch the filesystem.
 */
export function renderManifest(template: string, extId: string): string {
  return template.replaceAll("{{EXT_ID}}", extId);
}

interface CliArgs {
  outputPath: string;
  extManifestPath: string;
  templatePath: string;
}

function parseArgs(argv: string[]): CliArgs {
  // argv is process.argv.slice(2); first positional is the output path.
  const positional: string[] = [];
  let extManifestPath = DEFAULT_EXT_MANIFEST_PATH;
  let templatePath = DEFAULT_TEMPLATE_PATH;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--ext-manifest") {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error("--ext-manifest requires a path argument");
      }
      extManifestPath = next;
      i += 1;
    } else if (arg.startsWith("--ext-manifest=")) {
      extManifestPath = arg.slice("--ext-manifest=".length);
    } else if (arg === "--template") {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error("--template requires a path argument");
      }
      templatePath = next;
      i += 1;
    } else if (arg.startsWith("--template=")) {
      templatePath = arg.slice("--template=".length);
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    throw new Error(
      "usage: render-nmh-manifest <output-path> [--ext-manifest <path>] [--template <path>]",
    );
  }
  if (positional.length > 1) {
    throw new Error(
      `expected exactly one positional output path; got ${positional.length}`,
    );
  }
  return {
    outputPath: positional[0]!,
    extManifestPath,
    templatePath,
  };
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const extManifestRaw = await readFile(args.extManifestPath, "utf8");
  const extManifest = JSON.parse(extManifestRaw) as { key?: unknown };
  if (typeof extManifest.key !== "string" || extManifest.key.length === 0) {
    throw new Error(
      `ext manifest at ${args.extManifestPath} is missing a non-empty "key" field`,
    );
  }
  const extId = computeExtensionId(extManifest.key);
  const template = await readFile(args.templatePath, "utf8");
  const rendered = renderManifest(template, extId);
  await mkdir(dirname(args.outputPath), { recursive: true });
  await writeFile(args.outputPath, rendered, "utf8");
  process.stderr.write(
    `render-nmh-manifest: wrote ${args.outputPath} (EXT_ID=${extId})\n`,
  );
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(
      `render-nmh-manifest: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
