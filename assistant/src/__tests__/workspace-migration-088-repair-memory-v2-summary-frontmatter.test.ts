import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { parse as parseYaml } from "yaml";

import { repairMemoryV2SummaryFrontmatterMigration } from "../workspace/migrations/088-repair-memory-v2-summary-frontmatter.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-088-test-"));
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function conceptPath(relativePath: string): string {
  return join(workspaceDir, "memory", "concepts", relativePath);
}

function writeConcept(relativePath: string, content: string): string {
  const filePath = conceptPath(relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function read(filePath: string): string {
  return readFileSync(filePath, "utf-8");
}

function parseFrontmatter(filePath: string): Record<string, unknown> {
  const raw = read(filePath);
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error("Missing frontmatter");
  return (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
}

describe("088-repair-memory-v2-summary-frontmatter migration", () => {
  test("quotes unquoted summary values that contain YAML mapping syntax", () => {
    const filePath = writeConcept(
      "projects/example.md",
      [
        "---",
        "edges: []",
        "ref_files: []",
        "ref_urls: []",
        "summary: Example project: preserve the original summary text.",
        "---",
        "Body stays unchanged.",
      ].join("\n"),
    );

    expect(() => parseFrontmatter(filePath)).toThrow();

    repairMemoryV2SummaryFrontmatterMigration.run(workspaceDir);

    const parsed = parseFrontmatter(filePath);
    expect(parsed.summary).toBe(
      "Example project: preserve the original summary text.",
    );
    expect(read(filePath)).toContain("\nBody stays unchanged.");
  });

  test("quotes partially quoted summary values", () => {
    const filePath = writeConcept(
      "people/alice.md",
      [
        "---",
        "edges: []",
        'summary: "Alice" - reported an issue: follow up tomorrow.',
        "---",
        "Body",
      ].join("\n"),
    );

    expect(() => parseFrontmatter(filePath)).toThrow();

    repairMemoryV2SummaryFrontmatterMigration.run(workspaceDir);

    expect(parseFrontmatter(filePath).summary).toBe(
      '"Alice" - reported an issue: follow up tomorrow.',
    );
  });

  test("repairs quoted-looking summaries with unescaped inner quotes", () => {
    const filePath = writeConcept(
      "people/bob.md",
      [
        "---",
        "edges: []",
        "summary: 'Bob's project: track follow-ups.'",
        "---",
        "Body",
      ].join("\n"),
    );

    expect(() => parseFrontmatter(filePath)).toThrow();

    repairMemoryV2SummaryFrontmatterMigration.run(workspaceDir);

    expect(parseFrontmatter(filePath).summary).toBe(
      "Bob's project: track follow-ups.",
    );
  });

  test("removes null summary values", () => {
    const filePath = writeConcept(
      "objects/example-channel.md",
      ["---", "edges: []", "summary: null", "---", "Body"].join("\n"),
    );

    repairMemoryV2SummaryFrontmatterMigration.run(workspaceDir);

    const parsed = parseFrontmatter(filePath);
    expect(Object.hasOwn(parsed, "summary")).toBe(false);
    expect(read(filePath)).not.toContain("summary:");
  });

  test("leaves already quoted summaries unchanged", () => {
    const original = [
      "---",
      "edges: []",
      'summary: "Already safe: quoted text."',
      "---",
      "Body",
    ].join("\n");
    const filePath = writeConcept("objects/quoted.md", original);

    repairMemoryV2SummaryFrontmatterMigration.run(workspaceDir);

    expect(read(filePath)).toBe(original);
    expect(parseFrontmatter(filePath).summary).toBe(
      "Already safe: quoted text.",
    );
  });

  test("leaves simple unquoted summaries unchanged", () => {
    const original = [
      "---",
      "edges: []",
      "summary: Simple text",
      "---",
      "Body",
    ].join("\n");
    const filePath = writeConcept("objects/simple.md", original);

    repairMemoryV2SummaryFrontmatterMigration.run(workspaceDir);

    expect(read(filePath)).toBe(original);
    expect(parseFrontmatter(filePath).summary).toBe("Simple text");
  });

  test("ignores markdown outside memory concepts", () => {
    const filePath = join(workspaceDir, "notes", "example.md");
    mkdirSync(dirname(filePath), { recursive: true });
    const original = [
      "---",
      "summary: Outside concepts: should not be touched.",
      "---",
      "Body",
    ].join("\n");
    writeFileSync(filePath, original, "utf-8");

    repairMemoryV2SummaryFrontmatterMigration.run(workspaceDir);

    expect(read(filePath)).toBe(original);
  });

  test("repairs nested concept pages and is idempotent", () => {
    const filePath = writeConcept(
      "arcs/2026-05-18/example.md",
      [
        "---",
        "edges: []",
        "summary: Nested page: one-time repair.",
        "---",
        "Body",
      ].join("\n"),
    );

    repairMemoryV2SummaryFrontmatterMigration.run(workspaceDir);
    const once = read(filePath);
    repairMemoryV2SummaryFrontmatterMigration.run(workspaceDir);

    expect(read(filePath)).toBe(once);
    expect(parseFrontmatter(filePath).summary).toBe(
      "Nested page: one-time repair.",
    );
  });
});
