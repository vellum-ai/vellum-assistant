/**
 * When loadConfig()/loadRawConfig() quarantines a corrupt config.json, it
 * appends a bulletin to <workspace>/UPDATES.md so the background update-
 * bulletin job picks up the event inside a background-only conversation.
 * The agent decides whether to surface the quarantine to the user — it's
 * agent-visible context, not a push notification.
 *
 * The bulletin is keyed on the quarantine filename via an HTML marker so
 * repeated appends for the same quarantine are idempotent — per the
 * Release-Update-Hygiene rule in the root AGENTS.md, idempotency at both the
 * runner level AND an in-file marker is required to close the crash-mid-append
 * window.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _appendQuarantineBulletin,
  invalidateConfigCache,
  loadConfig,
} from "../config/loader.js";
import { _setStorePath } from "../security/encrypted-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");
const UPDATES_PATH = join(WORKSPACE_DIR, "UPDATES.md");

function ensureTestDir(): void {
  const dirs = [
    WORKSPACE_DIR,
    join(WORKSPACE_DIR, "data"),
    join(WORKSPACE_DIR, "data", "memory"),
    join(WORKSPACE_DIR, "data", "memory", "knowledge"),
    join(WORKSPACE_DIR, "data", "logs"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function resetWorkspace(): void {
  for (const name of readdirSync(WORKSPACE_DIR)) {
    rmSync(join(WORKSPACE_DIR, name), { recursive: true, force: true });
  }
  ensureTestDir();
}

function listQuarantinedFiles(): string[] {
  return readdirSync(WORKSPACE_DIR).filter((name) =>
    /^config\.json\.corrupt-.+\.json$/.test(name),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("config-quarantine UPDATES.md bulletin", () => {
  beforeEach(() => {
    resetWorkspace();
    _setStorePath(join(WORKSPACE_DIR, "keys.enc"));
    invalidateConfigCache();
  });

  afterEach(() => {
    _setStorePath(null);
    invalidateConfigCache();
  });

  test("writes a bulletin with the quarantine marker when config.json is corrupt", () => {
    writeFileSync(CONFIG_PATH, '{"provider": "anthropic", "mo');

    loadConfig();

    const [quarantinedName] = listQuarantinedFiles();
    expect(quarantinedName).toBeDefined();
    const quarantinedPath = join(WORKSPACE_DIR, quarantinedName);

    expect(existsSync(UPDATES_PATH)).toBe(true);
    const body = readFileSync(UPDATES_PATH, "utf-8");

    // Heading must match the wording the background update-bulletin job
    // relays to the user.
    expect(body).toContain("## Config was reset to defaults");
    // Quarantine file path is what the user cats to recover.
    expect(body).toContain(quarantinedPath);
    // Idempotency marker is shape-exact, basename-keyed (not full path).
    expect(body).toContain(`<!-- config-quarantine:${quarantinedName} -->`);
    expect(body).toMatch(
      /<!-- config-quarantine:config\.json\.corrupt-.+\.json -->/,
    );
  });

  test("two successive quarantines append two distinct bulletins (not overwrite)", () => {
    // First corruption round.
    writeFileSync(CONFIG_PATH, '{"partial": ');
    loadConfig();
    invalidateConfigCache();

    const firstQuarantined = listQuarantinedFiles();
    expect(firstQuarantined).toHaveLength(1);
    const firstBody = readFileSync(UPDATES_PATH, "utf-8");
    const firstMarker = `<!-- config-quarantine:${firstQuarantined[0]} -->`;
    expect(firstBody).toContain(firstMarker);

    // Loader wrote a fresh default config.json after quarantine; corrupt it
    // again. Sleep briefly to guarantee a different ISO-timestamp millisecond
    // component and therefore a distinct quarantine filename.
    const untilDifferentMs = Date.now() + 5;
    while (Date.now() < untilDifferentMs) {
      /* spin */
    }
    writeFileSync(CONFIG_PATH, "still not json");
    loadConfig();

    const quarantined = listQuarantinedFiles().sort();
    expect(quarantined).toHaveLength(2);

    const body = readFileSync(UPDATES_PATH, "utf-8");
    for (const name of quarantined) {
      expect(body).toContain(`<!-- config-quarantine:${name} -->`);
    }
    // Two "Config was reset to defaults" sections — appended, not overwritten.
    const headingMatches = body.match(/## Config was reset to defaults/g) ?? [];
    expect(headingMatches).toHaveLength(2);
    // The earlier marker is still present (append semantics).
    expect(body).toContain(firstMarker);
  });

  test("idempotent: pre-existing marker for the same quarantine filename skips the append", () => {
    // Simulate a crash-mid-append: UPDATES.md already contains a marker for
    // a specific quarantine filename. A follow-up call referencing the same
    // filename must leave the file untouched.
    const quarantineName = "config.json.corrupt-2026-04-20T12-00-00.000Z.json";
    const quarantinePath = join(WORKSPACE_DIR, quarantineName);
    const preexisting =
      `## Config was reset to defaults\n\n` +
      `Pre-existing bulletin for ${quarantinePath}.\n\n` +
      `<!-- config-quarantine:${quarantineName} -->\n`;
    writeFileSync(UPDATES_PATH, preexisting, "utf-8");
    // Also create the quarantine file on disk so the helper sees an
    // environment consistent with a prior successful rename.
    writeFileSync(quarantinePath, "{ not json", "utf-8");

    _appendQuarantineBulletin(CONFIG_PATH, quarantinePath);

    const after = readFileSync(UPDATES_PATH, "utf-8");
    expect(after).toBe(preexisting);
    // Exactly one marker present — no duplicate was appended.
    expect(
      after.match(
        new RegExp(`<!-- config-quarantine:${quarantineName} -->`, "g"),
      )?.length,
    ).toBe(1);
    expect(basename(quarantinePath)).toBe(quarantineName);
  });

  test("valid config.json does not create UPDATES.md (regression guard)", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ provider: "anthropic", model: "claude-opus-4-7" }),
    );

    loadConfig();

    expect(listQuarantinedFiles()).toHaveLength(0);
    expect(existsSync(UPDATES_PATH)).toBe(false);
  });

  test("appends (does not overwrite) when UPDATES.md already has unrelated content", () => {
    const priorContent =
      `## Some earlier bulletin\n\n` +
      `Unrelated prior content from a previous migration.\n\n` +
      `<!-- release-note-id:unrelated-note -->\n`;
    writeFileSync(UPDATES_PATH, priorContent, "utf-8");

    writeFileSync(CONFIG_PATH, "{oops");
    loadConfig();

    const body = readFileSync(UPDATES_PATH, "utf-8");
    // Prior content preserved verbatim at the start.
    expect(body.startsWith(priorContent)).toBe(true);
    // New bulletin appended.
    expect(body).toContain("## Config was reset to defaults");
    expect(body).toMatch(
      /<!-- config-quarantine:config\.json\.corrupt-.+\.json -->/,
    );
  });
});
