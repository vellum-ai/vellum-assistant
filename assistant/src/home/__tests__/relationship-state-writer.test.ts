import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the OAuth connection store so the writer runs without a
// database. Tests push provider rows into `fakeConnections` before
// invoking the writer.
type FakeConnection = {
  provider: string;
  status: "active" | "revoked" | "failed";
};
const fakeConnections: FakeConnection[] = [];

mock.module("../../oauth/oauth-store.js", () => ({
  listConnections: () => [...fakeConnections],
}));

// Dynamic import so the module resolves after the mock above is in
// place. Bun's mock.module needs to run before the real import is
// evaluated for the mock to take effect.
const {
  computeRelationshipState,
  getRelationshipStatePath,
  RELATIONSHIP_STATE_FILENAME,
  writeRelationshipState,
} = await import("../relationship-state-writer.js");

type RelationshipStateLike = {
  version: number;
  assistantId: string;
  tier: number;
  progressPercent: number;
  facts: Array<{
    id: string;
    category: string;
    text: string;
    confidence: string;
    source: string;
  }>;
  capabilities: Array<{
    id: string;
    name: string;
    description: string;
    tier: string;
    gate: string;
  }>;
  conversationCount: number;
  hatchedDate: string;
  assistantName: string;
  userName?: string;
  updatedAt: string;
};

// Per CI gotchas: each test gets its own temp workspace dir to avoid
// `.git/index.lock` style races on shared tmp paths.
let workspaceDir: string;
let origWorkspaceDir: string | undefined;

function writeFile(relPath: string, content: string): void {
  const full = join(workspaceDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

function seedConversations(count: number): void {
  const dir = join(workspaceDir, "conversations");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    mkdirSync(join(dir, `conv-${i}`), { recursive: true });
  }
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-rsw-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  fakeConnections.length = 0;
});

afterEach(() => {
  if (origWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = origWorkspaceDir;
  }
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("relationship-state-writer", () => {
  describe("getRelationshipStatePath", () => {
    test("returns <workspace>/data/relationship-state.json", () => {
      expect(getRelationshipStatePath()).toBe(
        join(workspaceDir, "data", RELATIONSHIP_STATE_FILENAME),
      );
    });
  });

  describe("computeRelationshipState", () => {
    test("fresh empty workspace -> tier 1, 0%, empty facts, 0 conversations", async () => {
      const state = (await computeRelationshipState()) as RelationshipStateLike;
      expect(state.version).toBe(1);
      expect(state.assistantId).toBe("default");
      expect(state.tier).toBe(1);
      expect(state.progressPercent).toBe(0);
      expect(state.conversationCount).toBe(0);
      expect(state.facts).toEqual([]);
      expect(state.capabilities).toHaveLength(6);
      // No integrations connected -> gated caps are next-up.
      const byId = Object.fromEntries(state.capabilities.map((c) => [c.id, c]));
      expect(byId.email.tier).toBe("next-up");
      expect(byId.calendar.tier).toBe("next-up");
      expect(byId.slack.tier).toBe("next-up");
      expect(byId["voice-writing"].tier).toBe("earned");
      expect(byId.proactive.tier).toBe("earned");
      expect(byId.autonomous.tier).toBe("earned");
    });

    test("extracts world + priorities facts from USER.md", async () => {
      writeFile(
        "USER.md",
        [
          "# USER.md",
          "",
          "- Preferred name: Alex",
          "- Pronouns: they/them",
          "- Work role: Staff engineer",
          "- Goals: Ship Phase 3 by Friday",
          "- Daily tools: VSCode, git, bun",
          "",
        ].join("\n"),
      );

      const state = (await computeRelationshipState()) as RelationshipStateLike;
      // At least one priorities fact (Goals / Work role / Daily tools)
      // and at least one world fact (Preferred name / Pronouns).
      expect(state.facts.length).toBeGreaterThanOrEqual(5);
      const categories = new Set(state.facts.map((f) => f.category));
      expect(categories.has("priorities")).toBe(true);
      expect(categories.has("world")).toBe(true);
      // All extracted facts are "inferred" (not "onboarding").
      for (const f of state.facts) {
        expect(f.source).toBe("inferred");
      }
      // userName parsed from "Preferred name: Alex".
      expect(state.userName).toBe("Alex");
    });

    test("extracts voice facts from SOUL.md", async () => {
      writeFile(
        "SOUL.md",
        [
          "# SOUL.md",
          "",
          "- Tone: dry, precise, never performative",
          "- Defaults: lowercase, minimal punctuation",
          "",
        ].join("\n"),
      );

      const state = (await computeRelationshipState()) as RelationshipStateLike;
      const voiceFacts = state.facts.filter((f) => f.category === "voice");
      expect(voiceFacts.length).toBeGreaterThanOrEqual(2);
      for (const f of voiceFacts) {
        expect(f.source).toBe("inferred");
      }
    });

    test("falls back to legacy workspace USER.md when persona resolver yields nothing", async () => {
      // In the test environment there is no guardian contact in the DB, so
      // `resolveGuardianPersonaPath()` either returns null or throws — the
      // writer must degrade to legacy workspace-root `USER.md`.
      writeFile(
        "USER.md",
        ["- Preferred name: Jamie", "- Work role: PM"].join("\n"),
      );

      const state = (await computeRelationshipState()) as RelationshipStateLike;
      expect(state.userName).toBe("Jamie");
      expect(state.facts.length).toBeGreaterThan(0);
    });

    test("counts files in conversations dir as conversationCount", async () => {
      seedConversations(7);
      const state = (await computeRelationshipState()) as RelationshipStateLike;
      expect(state.conversationCount).toBe(7);
    });

    test("slack connection flips slack capability to unlocked", async () => {
      fakeConnections.push({ provider: "slack", status: "active" });
      const state = (await computeRelationshipState()) as RelationshipStateLike;
      const slack = state.capabilities.find((c) => c.id === "slack");
      expect(slack?.tier).toBe("unlocked");
      const email = state.capabilities.find((c) => c.id === "email");
      expect(email?.tier).toBe("next-up");
    });

    test("google connection unlocks both email and calendar", async () => {
      fakeConnections.push({ provider: "google", status: "active" });
      const state = (await computeRelationshipState()) as RelationshipStateLike;
      const email = state.capabilities.find((c) => c.id === "email");
      const calendar = state.capabilities.find((c) => c.id === "calendar");
      expect(email?.tier).toBe("unlocked");
      expect(calendar?.tier).toBe("unlocked");
    });

    test("outlook connection unlocks both email and calendar", async () => {
      // `outlook` is the real provider key used by seed-providers.ts for
      // the Microsoft integration (carries Calendars.* scopes). Regression
      // guard: an active Outlook connection must flip calendar to unlocked
      // the same way it flips email.
      fakeConnections.push({ provider: "outlook", status: "active" });
      const state = (await computeRelationshipState()) as RelationshipStateLike;
      const email = state.capabilities.find((c) => c.id === "email");
      const calendar = state.capabilities.find((c) => c.id === "calendar");
      expect(email?.tier).toBe("unlocked");
      expect(calendar?.tier).toBe("unlocked");
    });

    test("revoked connections do not count as unlocked", async () => {
      fakeConnections.push({ provider: "slack", status: "revoked" });
      const state = (await computeRelationshipState()) as RelationshipStateLike;
      const slack = state.capabilities.find((c) => c.id === "slack");
      expect(slack?.tier).toBe("next-up");
    });

    test("voice-writing unlocks once conversationCount >= 10", async () => {
      seedConversations(10);
      const state = (await computeRelationshipState()) as RelationshipStateLike;
      const voice = state.capabilities.find((c) => c.id === "voice-writing");
      expect(voice?.tier).toBe("unlocked");
    });

    test("updatedAt is a valid ISO-8601 string", async () => {
      const state = (await computeRelationshipState()) as RelationshipStateLike;
      expect(Number.isNaN(Date.parse(state.updatedAt))).toBe(false);
    });
  });

  describe("writeRelationshipState", () => {
    test("writes to <workspace>/data/relationship-state.json", async () => {
      writeFile("USER.md", "- Preferred name: Sam");
      seedConversations(3);

      await writeRelationshipState();

      const path = getRelationshipStatePath();
      expect(existsSync(path)).toBe(true);

      const decoded = JSON.parse(
        readFileSync(path, "utf-8"),
      ) as RelationshipStateLike;
      expect(decoded.version).toBe(1);
      expect(decoded.assistantId).toBe("default");
      expect(decoded.conversationCount).toBe(3);
      expect(decoded.userName).toBe("Sam");
      expect(decoded.capabilities).toHaveLength(6);
      expect(decoded.tier).toBe(1);
    });

    test("never throws when the workspace is unwritable-ish", async () => {
      // Point the workspace override at a nested path under a file to
      // force mkdirSync to fail. The public API must swallow this.
      const sentinelFile = join(workspaceDir, "blocker");
      writeFileSync(sentinelFile, "blocking", "utf-8");
      process.env.VELLUM_WORKSPACE_DIR = join(sentinelFile, "nested");

      await expect(writeRelationshipState()).resolves.toBeUndefined();
    });
  });
});
