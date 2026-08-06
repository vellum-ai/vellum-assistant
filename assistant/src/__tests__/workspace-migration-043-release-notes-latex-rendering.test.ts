/**
 * Tests for workspace migration `043-release-notes-latex-rendering`.
 *
 * Pins the four idempotency paths covered by the in-file HTML marker logic
 * the migration uses to guard against duplicate appends (crash between
 * `appendFileSync` and the runner's checkpoint promotion, or hand-edits to
 * UPDATES.md after a partial prior run):
 *
 *   (a) Empty workspace — UPDATES.md is created with the marker + body.
 *   (b) Existing UPDATES.md without the marker — append with one blank line
 *       between prior content and the new note.
 *   (c) Existing UPDATES.md with the marker already present — byte-identical
 *       re-run (asserted twice).
 *   (d) Existing UPDATES.md ending with `\n` vs `\n\n` — both produce exactly
 *       one blank line between old and new content (no triple-newline, no
 *       missing separator).
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { releaseNotesLatexRenderingMigration } from "../workspace/migrations/043-release-notes-latex-rendering.js";

const MIGRATION_ID = "043-release-notes-latex-rendering";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

let testRoot: string;
let workspaceDir: string;

beforeAll(() => {
  testRoot = mkdtempSync(join(tmpdir(), "migration-043-test-"));
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

beforeEach(() => {
  workspaceDir = mkdtempSync(join(testRoot, "ws-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function updatesPath(): string {
  return join(workspaceDir, "UPDATES.md");
}

describe("workspace migration 043-release-notes-latex-rendering", () => {
  test("has the correct id and description", () => {
    expect(releaseNotesLatexRenderingMigration.id).toBe(MIGRATION_ID);
    expect(releaseNotesLatexRenderingMigration.description).toContain(
      "LaTeX block-math rendering",
    );
  });

  // ─── (a) Empty workspace ──────────────────────────────────────────

  test("creates UPDATES.md with marker and body when file is absent", () => {
    expect(existsSync(updatesPath())).toBe(false);

    releaseNotesLatexRenderingMigration.run(workspaceDir);

    expect(existsSync(updatesPath())).toBe(true);
    const content = readFileSync(updatesPath(), "utf-8");
    expect(content).toContain(MARKER);
    expect(content).toContain("## LaTeX math rendering in chat");
    expect(content).toContain("$$...$$");
    // First-time write has no leading separator — starts directly with the marker.
    expect(content.startsWith(MARKER)).toBe(true);
  });

  // ─── (b) Existing UPDATES.md without the marker ───────────────────

  test("appends to existing UPDATES.md when marker is absent, preserving prior content with one blank line between blocks", () => {
    const priorContent =
      "## Earlier note\n\nSomething the assistant wrote before.\n";
    writeFileSync(updatesPath(), priorContent, "utf-8");

    releaseNotesLatexRenderingMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    // Prior content preserved.
    expect(content.startsWith(priorContent)).toBe(true);
    // Marker present once.
    expect(content.split(MARKER).length - 1).toBe(1);
    // Exactly one blank line between old and new content: prior ends with
    // `\n`, so we expect a single `\n` separator added, producing `\n\n`
    // (one blank line) immediately before the marker.
    expect(content).toBe(
      `${priorContent}\n${content.slice(priorContent.length + 1)}`,
    );
    // The appended block starts at the marker.
    expect(content.slice(priorContent.length)).toMatch(
      /^\n<!-- release-note-id:/,
    );
    // No triple-newline (would indicate a stray blank line).
    expect(content).not.toContain("\n\n\n");
  });

  // ─── (c) Existing UPDATES.md with marker — byte-identical re-run ──

  test("is a no-op when marker is already present, byte-identical across two runs", () => {
    // Seed with a file that already contains the marker (prior successful run).
    const seeded = `## Something pre-existing\n\n${MARKER}\n## LaTeX math rendering in chat\n\nBody.\n`;
    writeFileSync(updatesPath(), seeded, "utf-8");

    const before = readFileSync(updatesPath(), "utf-8");

    releaseNotesLatexRenderingMigration.run(workspaceDir);
    const afterFirst = readFileSync(updatesPath(), "utf-8");
    expect(afterFirst).toBe(before);

    releaseNotesLatexRenderingMigration.run(workspaceDir);
    const afterSecond = readFileSync(updatesPath(), "utf-8");
    expect(afterSecond).toBe(before);

    // Marker still appears exactly once.
    expect(afterSecond.split(MARKER).length - 1).toBe(1);
  });

  // ─── (d) Trailing-newline variations ──────────────────────────────

  test("existing UPDATES.md ending with a single trailing newline produces exactly one blank line separator", () => {
    const prior = "## Prior\n\nBody line.\n"; // ends with exactly one `\n`
    expect(prior.endsWith("\n")).toBe(true);
    expect(prior.endsWith("\n\n")).toBe(false);
    writeFileSync(updatesPath(), prior, "utf-8");

    releaseNotesLatexRenderingMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    // Prior preserved verbatim at the start.
    expect(content.startsWith(prior)).toBe(true);
    // Exactly one blank line (i.e. `\n\n`) between prior content's final
    // character (which is `\n`) and the marker. So the bytes immediately
    // after `prior` must begin with `\n<!-- release-note-id:` — the extra
    // `\n` combined with prior's trailing `\n` yields a single blank line.
    expect(content.slice(prior.length)).toMatch(/^\n<!-- release-note-id:/);
    // No triple-newline anywhere.
    expect(content).not.toContain("\n\n\n");
  });

  test("existing UPDATES.md ending with two trailing newlines produces exactly one blank line separator (no extra padding)", () => {
    const prior = "## Prior\n\nBody line.\n\n"; // ends with `\n\n`
    expect(prior.endsWith("\n\n")).toBe(true);
    writeFileSync(updatesPath(), prior, "utf-8");

    releaseNotesLatexRenderingMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    // Prior preserved verbatim.
    expect(content.startsWith(prior)).toBe(true);
    // Prior already ends with a blank line; the migration should append the
    // marker directly with no additional separator. The bytes immediately
    // after `prior` must begin with the marker itself.
    expect(content.slice(prior.length).startsWith(MARKER)).toBe(true);
    // No triple-newline anywhere.
    expect(content).not.toContain("\n\n\n");
  });

  test("existing UPDATES.md with no trailing newline produces exactly one blank line separator", () => {
    const prior = "## Prior\n\nBody line."; // no trailing newline
    expect(prior.endsWith("\n")).toBe(false);
    writeFileSync(updatesPath(), prior, "utf-8");

    releaseNotesLatexRenderingMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(content.startsWith(prior)).toBe(true);
    // Separator must be `\n\n` (blank line) before the marker since there
    // was no trailing newline at all.
    expect(content.slice(prior.length)).toMatch(/^\n\n<!-- release-note-id:/);
    expect(content).not.toContain("\n\n\n");
  });

  // ─── down() is a no-op ────────────────────────────────────────────

  test("down() is a no-op and does not throw", () => {
    writeFileSync(updatesPath(), `${MARKER}\nBody.\n`, "utf-8");
    const before = readFileSync(updatesPath(), "utf-8");

    releaseNotesLatexRenderingMigration.down(workspaceDir);

    expect(readFileSync(updatesPath(), "utf-8")).toBe(before);
  });
});
