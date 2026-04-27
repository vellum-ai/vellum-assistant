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

import { releaseNotesAcpSessionsUiMigration } from "../workspace/migrations/058-release-notes-acp-sessions-ui.js";

const MIGRATION_ID = "058-release-notes-acp-sessions-ui";
const MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

let testRoot: string;
let workspaceDir: string;

beforeAll(() => {
  testRoot = mkdtempSync(join(tmpdir(), "migration-058-test-"));
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

describe("workspace migration 058-release-notes-acp-sessions-ui", () => {
  test("has the correct id and description", () => {
    expect(releaseNotesAcpSessionsUiMigration.id).toBe(MIGRATION_ID);
    expect(releaseNotesAcpSessionsUiMigration.description).toContain(
      "Coding Agents",
    );
  });

  test("creates UPDATES.md with marker and key copy when file is absent", () => {
    expect(existsSync(updatesPath())).toBe(false);

    releaseNotesAcpSessionsUiMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(content.startsWith(MARKER)).toBe(true);
    expect(content).toContain("Coding Agents");
    expect(content).toContain("Codex");
    expect(content).toContain("Claude");
    expect(content).toContain("Acp Spawn");
    expect(content).toContain("per-conversation filter");
    expect(content).toContain("persist across assistant and app restarts");
    expect(content).toContain("agent_thought_chunk");
    expect(content).toContain("italic secondary text");
  });

  test("appends to existing UPDATES.md when marker is absent and preserves existing content", () => {
    const prior = "## Earlier note\n\nSomething already queued.\n";
    writeFileSync(updatesPath(), prior, "utf-8");

    releaseNotesAcpSessionsUiMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(content.startsWith(prior)).toBe(true);
    expect(content.slice(prior.length).startsWith(`\n${MARKER}`)).toBe(true);
    expect(content.split(MARKER).length - 1).toBe(1);
    expect(content).not.toContain("\n\n\n");
  });

  test("is a no-op when marker is already present", () => {
    const seeded = `## Prior\n\n${MARKER}\n## Coding Agents\n\nAlready appended.\n`;
    writeFileSync(updatesPath(), seeded, "utf-8");

    releaseNotesAcpSessionsUiMigration.run(workspaceDir);
    const afterFirst = readFileSync(updatesPath(), "utf-8");
    expect(afterFirst).toBe(seeded);

    releaseNotesAcpSessionsUiMigration.run(workspaceDir);
    const afterSecond = readFileSync(updatesPath(), "utf-8");
    expect(afterSecond).toBe(seeded);
    expect(afterSecond.split(MARKER).length - 1).toBe(1);
  });

  test("running twice on a fresh workspace appends only once (idempotent)", () => {
    releaseNotesAcpSessionsUiMigration.run(workspaceDir);
    const afterFirst = readFileSync(updatesPath(), "utf-8");

    releaseNotesAcpSessionsUiMigration.run(workspaceDir);
    const afterSecond = readFileSync(updatesPath(), "utf-8");

    expect(afterSecond).toBe(afterFirst);
    expect(afterSecond.split(MARKER).length - 1).toBe(1);
  });

  test("re-creates UPDATES.md when it was deleted between runs", () => {
    releaseNotesAcpSessionsUiMigration.run(workspaceDir);
    expect(existsSync(updatesPath())).toBe(true);

    rmSync(updatesPath());

    releaseNotesAcpSessionsUiMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(content.startsWith(MARKER)).toBe(true);
    expect(content).toContain("Coding Agents");
  });

  test("existing UPDATES.md with no trailing newline gets one blank line separator", () => {
    const prior = "## Prior\n\nBody.";
    writeFileSync(updatesPath(), prior, "utf-8");

    releaseNotesAcpSessionsUiMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(content.startsWith(prior)).toBe(true);
    expect(content.slice(prior.length).startsWith(`\n\n${MARKER}`)).toBe(true);
    expect(content).not.toContain("\n\n\n");
  });

  test("down() is a no-op", () => {
    writeFileSync(updatesPath(), `${MARKER}\nBody.\n`, "utf-8");
    const before = readFileSync(updatesPath(), "utf-8");

    releaseNotesAcpSessionsUiMigration.down(workspaceDir);

    expect(readFileSync(updatesPath(), "utf-8")).toBe(before);
  });
});
