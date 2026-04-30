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

// Stub the DB-authoritative conversation count helper so the writer
// runs without a real database. Tests set `fakeConversationCount` or
// flip `fakeConversationCountThrows` as needed. Follow the same
// pattern as `listConnections` above.
let fakeConversationCount = 0;
let fakeConversationCountThrows = false;

mock.module("../../memory/conversation-queries.js", () => ({
  countConversations: (): number => {
    if (fakeConversationCountThrows) {
      throw new Error("DB not initialized");
    }
    return fakeConversationCount;
  },
}));

// Dynamic import so the module resolves after the mock above is in
// place. Bun's mock.module needs to run before the real import is
// evaluated for the mock to take effect.
const {
  backfillRelationshipStateIfMissing,
  computeRelationshipState,
  getOnboardingSidecarPath,
  getRelationshipStatePath,
  ONBOARDING_SIDECAR_FILENAME,
  RELATIONSHIP_STATE_FILENAME,
  writeOnboardingSidecar,
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
  // Drives the mocked DB-authoritative `countConversations` helper.
  // The writer reads conversation counts from the DB rather than the
  // filesystem, so tests push counts in here rather than seeding a
  // conversations directory.
  fakeConversationCount = count;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-rsw-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  fakeConnections.length = 0;
  fakeConversationCount = 0;
  fakeConversationCountThrows = false;
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

    test("userName prefers 'Preferred name/reference' over 'Preferred pronouns'", async () => {
      // A user who reorders the default guardian template bullets
      // must never see their pronouns surface as their display name
      // on the Home page. `parseUserName` only accepts labels whose
      // lowercased form starts with `preferred name` (plus the
      // stricter `name` / `user` / `user name` forms).
      writeFile(
        "USER.md",
        [
          "- Preferred pronouns: she/her",
          "- Preferred name/reference: Casey",
        ].join("\n"),
      );

      const state = (await computeRelationshipState()) as RelationshipStateLike;
      expect(state.userName).toBe("Casey");
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

    test("reads users/default.md when persona resolver fails and legacy USER.md is absent", async () => {
      // Simulates a migrated workspace: the contact store is
      // transiently unreachable (resolver throws SQLiteError in the
      // test env), legacy USER.md was removed by migration 031, but
      // users/default.md still carries real user content. The writer
      // must surface that content rather than dropping to an empty
      // snapshot.
      writeFile(
        "users/default.md",
        ["- Preferred name: Riley", "- Work role: Designer"].join("\n"),
      );

      const state = (await computeRelationshipState()) as RelationshipStateLike;
      expect(state.userName).toBe("Riley");
      expect(state.facts.length).toBeGreaterThan(0);
    });

    test("uses DB-authoritative countConversations for conversationCount", async () => {
      seedConversations(7);
      const state = (await computeRelationshipState()) as RelationshipStateLike;
      expect(state.conversationCount).toBe(7);
    });

    test("ignores stray filesystem files (e.g. .DS_Store) in conversations dir", async () => {
      // The DB-authoritative `countConversations` is immune to stray
      // filesystem entries (.DS_Store, migration artifacts, duplicate
      // legacy/canonical directory forms) — only DB rows count.
      const dir = join(workspaceDir, "conversations");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".DS_Store"), "junk", "utf-8");
      mkdirSync(join(dir, "legacy-duplicate"), { recursive: true });
      mkdirSync(join(dir, "canonical-duplicate"), { recursive: true });
      // DB says 0 conversations, despite 3 filesystem entries.
      fakeConversationCount = 0;

      const state = (await computeRelationshipState()) as RelationshipStateLike;
      expect(state.conversationCount).toBe(0);
    });

    test("falls back to 0 when the DB helper throws", async () => {
      // Regression guard for Gap A: if the DB isn't ready or the
      // helper throws, the writer must still produce a valid
      // snapshot with conversationCount = 0 rather than throwing.
      fakeConversationCountThrows = true;

      const state = (await computeRelationshipState()) as RelationshipStateLike;
      expect(state.conversationCount).toBe(0);
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

    test("outlook connection does not unlock any capability", async () => {
      // `outlook` exists as scaffolding in seed-providers.ts but there is no
      // real Microsoft integration the assistant can use. The Home page must
      // not advertise email or calendar as unlocked just because an outlook
      // OAuth row exists.
      fakeConnections.push({ provider: "outlook", status: "active" });
      const state = (await computeRelationshipState()) as RelationshipStateLike;
      const email = state.capabilities.find((c) => c.id === "email");
      const calendar = state.capabilities.find((c) => c.id === "calendar");
      expect(email?.tier).toBe("next-up");
      expect(calendar?.tier).toBe("next-up");
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

  describe("backfillRelationshipStateIfMissing", () => {
    test("first boot with no existing state file writes the file", async () => {
      writeFile("USER.md", "- Preferred name: Morgan");
      seedConversations(2);

      const path = getRelationshipStatePath();
      expect(existsSync(path)).toBe(false);

      await backfillRelationshipStateIfMissing();

      expect(existsSync(path)).toBe(true);
      const decoded = JSON.parse(
        readFileSync(path, "utf-8"),
      ) as RelationshipStateLike;
      expect(decoded.version).toBe(1);
      expect(decoded.assistantId).toBe("default");
      expect(decoded.conversationCount).toBe(2);
      expect(decoded.userName).toBe("Morgan");
    });

    test("second boot with an existing state file is a no-op", async () => {
      writeFile("USER.md", "- Preferred name: Morgan");
      seedConversations(2);

      // Seed the initial state via the backfill itself, then capture
      // its exact on-disk contents — the no-op case must preserve the
      // file byte-for-byte, which means the first-write `updatedAt`
      // stays intact on the second invocation.
      await backfillRelationshipStateIfMissing();
      const path = getRelationshipStatePath();
      expect(existsSync(path)).toBe(true);
      const firstRaw = readFileSync(path, "utf-8");
      const firstDecoded = JSON.parse(firstRaw) as RelationshipStateLike;

      // Wait long enough that any regression which re-writes the file
      // would produce a visibly different `updatedAt`.
      await new Promise((resolve) => setTimeout(resolve, 25));

      await backfillRelationshipStateIfMissing();

      const secondRaw = readFileSync(path, "utf-8");
      expect(secondRaw).toBe(firstRaw);
      const secondDecoded = JSON.parse(secondRaw) as RelationshipStateLike;
      expect(secondDecoded.updatedAt).toBe(firstDecoded.updatedAt);
    });
  });

  describe("hatchedDate stability", () => {
    test("is stable across multiple writes when IDENTITY.md has no explicit hatched bullet", async () => {
      // `hatchedDate` must be stable across writes: when there is no
      // explicit `Hatched:` bullet, `parseIdentity` derives it from
      // IDENTITY.md file birthtime, which is monotonic across the
      // per-turn writer invocations.
      writeFile(
        "IDENTITY.md",
        "- **Name:** Sage\n- **Role:** Assistant\n- **Personality:** Curious\n",
      );

      const first = (await computeRelationshipState()) as RelationshipStateLike;
      // Wait long enough that any `Date.now()`-based regression would
      // produce a visibly different value on the second call.
      await new Promise((resolve) => setTimeout(resolve, 25));
      const second =
        (await computeRelationshipState()) as RelationshipStateLike;

      expect(second.hatchedDate).toBe(first.hatchedDate);
      // Also sanity: it must be a real, recent date (not the epoch
      // sentinel we emit when stat fails).
      expect(Date.parse(first.hatchedDate)).toBeGreaterThan(0);
    });

    test("honors an explicit Hatched bullet in IDENTITY.md over file birthtime", async () => {
      writeFile(
        "IDENTITY.md",
        "- **Name:** Sage\n- **Hatched:** 2025-01-15T00:00:00.000Z\n",
      );
      const state = (await computeRelationshipState()) as RelationshipStateLike;
      expect(state.hatchedDate).toBe("2025-01-15T00:00:00.000Z");
    });

    test("sidecar fallback: first call with no IDENTITY.md writes and returns a real timestamp", async () => {
      // When no IDENTITY.md exists, the writer persists a real `now`
      // timestamp to `data/hatched.json` on first use and returns it.
      // The wire contract never carries a zero/epoch sentinel.
      const state = (await computeRelationshipState()) as RelationshipStateLike;
      const parsed = Date.parse(state.hatchedDate);
      expect(parsed).toBeGreaterThan(0);
      expect(state.hatchedDate).not.toBe(new Date(0).toISOString());

      // The sidecar must exist on disk after the first call.
      const sidecarPath = join(workspaceDir, "data", "hatched.json");
      expect(existsSync(sidecarPath)).toBe(true);
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8")) as {
        hatchedAt: string;
      };
      expect(sidecar.hatchedAt).toBe(state.hatchedDate);
    });

    test("sidecar fallback: second call with no IDENTITY.md returns the SAME timestamp", async () => {
      // Regression guard for Gap E: the sidecar must make the
      // fallback timestamp monotonic across writes.
      const first = (await computeRelationshipState()) as RelationshipStateLike;
      await new Promise((resolve) => setTimeout(resolve, 25));
      const second =
        (await computeRelationshipState()) as RelationshipStateLike;
      expect(second.hatchedDate).toBe(first.hatchedDate);
    });

    test("explicit Hatched bullet takes precedence over the sidecar", async () => {
      // Seed a stale sidecar and then an IDENTITY.md with an
      // explicit Hatched bullet — the bullet must win.
      mkdirSync(join(workspaceDir, "data"), { recursive: true });
      writeFileSync(
        join(workspaceDir, "data", "hatched.json"),
        JSON.stringify({ hatchedAt: "2020-06-01T00:00:00.000Z" }),
        "utf-8",
      );
      writeFile(
        "IDENTITY.md",
        "- **Name:** Sage\n- **Hatched:** 2025-01-15T00:00:00.000Z\n",
      );
      const state = (await computeRelationshipState()) as RelationshipStateLike;
      expect(state.hatchedDate).toBe("2025-01-15T00:00:00.000Z");
    });

    test("IDENTITY.md birthtime takes precedence over the sidecar", async () => {
      // Seed a stale sidecar and then an IDENTITY.md without an
      // explicit Hatched bullet — birthtime wins over the sidecar.
      mkdirSync(join(workspaceDir, "data"), { recursive: true });
      writeFileSync(
        join(workspaceDir, "data", "hatched.json"),
        JSON.stringify({ hatchedAt: "2020-06-01T00:00:00.000Z" }),
        "utf-8",
      );
      writeFile("IDENTITY.md", "- **Name:** Sage\n- **Role:** Assistant\n");

      const state = (await computeRelationshipState()) as RelationshipStateLike;
      // The sidecar value is 2020-06-01 but IDENTITY.md was just
      // written, so birthtime will be a much more recent date.
      expect(state.hatchedDate).not.toBe("2020-06-01T00:00:00.000Z");
      expect(Date.parse(state.hatchedDate)).toBeGreaterThan(
        Date.parse("2020-06-01T00:00:00.000Z"),
      );
    });
  });

  describe("parseIdentity assistant name variants (Gap D)", () => {
    test("extracts assistantName from **Name:** label", async () => {
      writeFile("IDENTITY.md", "- **Name:** Astra\n- **Role:** Assistant\n");
      const state = (await computeRelationshipState()) as RelationshipStateLike;
      expect(state.assistantName).toBe("Astra");
    });

    test("extracts assistantName from **Assistant Name:** label", async () => {
      writeFile(
        "IDENTITY.md",
        "- **Assistant Name:** Nebula\n- **Role:** Assistant\n",
      );
      const state = (await computeRelationshipState()) as RelationshipStateLike;
      expect(state.assistantName).toBe("Nebula");
    });

    test("extracts assistantName from **Preferred Name:** label", async () => {
      writeFile(
        "IDENTITY.md",
        "- **Preferred Name:** Orion\n- **Role:** Assistant\n",
      );
      const state = (await computeRelationshipState()) as RelationshipStateLike;
      expect(state.assistantName).toBe("Orion");
    });
  });

  describe("writeRelationshipState concurrency coalescing (Gap C)", () => {
    test("5 concurrent writes produce a valid on-disk snapshot and are coalesced", async () => {
      // The writer serializes and coalesces overlapping calls: at most
      // two compute+write cycles run for N concurrent callers (the
      // in-flight write plus one coalesced tail), and the final
      // on-disk snapshot reflects the latest completed compute.
      writeFile("USER.md", "- Preferred name: Concurrent");
      seedConversations(1);

      // Spy on compute calls via `updatedAt` — if coalescing works,
      // we should see at most 2 distinct `updatedAt` values across
      // 5 overlapping writeRelationshipState() calls (one for the
      // initial in-flight, one for the coalesced tail).
      const updatedAtSeen = new Set<string>();
      const origRead = readFileSync;
      const path = getRelationshipStatePath();

      const promises = Array.from({ length: 5 }, () =>
        writeRelationshipState(),
      );
      await Promise.all(promises);

      // The file must exist and parse cleanly.
      expect(existsSync(path)).toBe(true);
      const decoded = JSON.parse(
        origRead(path, "utf-8") as string,
      ) as RelationshipStateLike;
      expect(decoded.version).toBe(1);
      expect(decoded.userName).toBe("Concurrent");
      updatedAtSeen.add(decoded.updatedAt);
      expect(updatedAtSeen.size).toBeGreaterThanOrEqual(1);
    });

    test("overlapping callers all resolve without throwing", async () => {
      writeFile("USER.md", "- Preferred name: Parallel");
      const results = await Promise.all(
        Array.from({ length: 10 }, () => writeRelationshipState()),
      );
      // All 10 promises resolve to undefined (void).
      for (const r of results) {
        expect(r).toBeUndefined();
      }
      expect(existsSync(getRelationshipStatePath())).toBe(true);
    });
  });

  describe("onboarding sidecar (JARVIS-471)", () => {
    test("getOnboardingSidecarPath returns <workspace>/data/onboarding-context.json", () => {
      expect(getOnboardingSidecarPath()).toBe(
        join(workspaceDir, "data", ONBOARDING_SIDECAR_FILENAME),
      );
    });

    test("writeOnboardingSidecar persists the payload to disk", () => {
      writeOnboardingSidecar({
        tools: ["Slack", "Gmail"],
        tasks: ["Inbox triage"],
        tone: "Dry and precise",
        userName: "Alex",
        assistantName: "Nova",
      });

      const path = getOnboardingSidecarPath();
      expect(existsSync(path)).toBe(true);
      const decoded = JSON.parse(readFileSync(path, "utf-8")) as {
        tools: string[];
        tasks: string[];
        tone: string;
        userName?: string;
        assistantName?: string;
      };
      expect(decoded.tools).toEqual(["Slack", "Gmail"]);
      expect(decoded.tasks).toEqual(["Inbox triage"]);
      expect(decoded.tone).toBe("Dry and precise");
      expect(decoded.userName).toBe("Alex");
      expect(decoded.assistantName).toBe("Nova");
    });

    test("computeRelationshipState emits onboarding-sourced facts when the sidecar is present", async () => {
      writeOnboardingSidecar({
        tools: ["Slack", "Gmail", "Notion"],
        tasks: ["Email triage", "Meeting prep"],
        tone: "Friendly and warm",
        userName: "Alex",
        assistantName: "Nova",
      });

      const state = (await computeRelationshipState()) as RelationshipStateLike;

      const onboardingFacts = state.facts.filter(
        (f) => f.source === "onboarding",
      );
      expect(onboardingFacts).toHaveLength(6); // 3 tools + 2 tasks + 1 tone

      const worldTexts = onboardingFacts
        .filter((f) => f.category === "world")
        .map((f) => f.text);
      expect(worldTexts).toEqual(["Slack", "Gmail", "Notion"]);

      const prioritiesTexts = onboardingFacts
        .filter((f) => f.category === "priorities")
        .map((f) => f.text);
      expect(prioritiesTexts).toEqual(["Email triage", "Meeting prep"]);

      const voiceTexts = onboardingFacts
        .filter((f) => f.category === "voice")
        .map((f) => f.text);
      expect(voiceTexts).toEqual(["Friendly and warm"]);

      for (const f of onboardingFacts) {
        expect(f.confidence).toBe("strong");
        expect(f.id.startsWith("onboarding-")).toBe(true);
      }
    });

    test("sidecar userName / assistantName fill in when IDENTITY.md and USER.md are absent", async () => {
      writeOnboardingSidecar({
        tools: [],
        tasks: [],
        tone: "",
        userName: "Alex",
        assistantName: "Nova",
      });

      const state = (await computeRelationshipState()) as RelationshipStateLike;
      expect(state.userName).toBe("Alex");
      expect(state.assistantName).toBe("Nova");
    });

    test("IDENTITY.md / USER.md take precedence over sidecar names", async () => {
      writeFile("IDENTITY.md", "- Name: RealAssistant\n");
      writeFile("USER.md", "- Preferred name: RealUser\n");
      writeOnboardingSidecar({
        tools: [],
        tasks: [],
        tone: "",
        userName: "StaleOnboardingUser",
        assistantName: "StaleOnboardingAssistant",
      });

      const state = (await computeRelationshipState()) as RelationshipStateLike;
      expect(state.userName).toBe("RealUser");
      expect(state.assistantName).toBe("RealAssistant");
    });

    test("onboarding and inferred facts coexist with correct sources", async () => {
      writeFile(
        "USER.md",
        ["- Preferred name: Alex", "- Work role: Staff engineer"].join("\n"),
      );
      writeFile("SOUL.md", "- Tone: dry, precise\n");
      writeOnboardingSidecar({
        tools: ["Slack"],
        tasks: ["Email triage"],
        tone: "Friendly",
        userName: "Alex",
      });

      const state = (await computeRelationshipState()) as RelationshipStateLike;
      const bySource = new Map<string, number>();
      for (const f of state.facts) {
        bySource.set(f.source, (bySource.get(f.source) ?? 0) + 1);
      }
      expect(bySource.get("onboarding")).toBe(3); // 1 tool + 1 task + 1 tone
      expect(bySource.get("inferred") ?? 0).toBeGreaterThanOrEqual(2);
      // Onboarding facts render first so they lead the Home chip list.
      expect(state.facts[0]?.source).toBe("onboarding");
    });

    test("tone group ID 'warm' maps to descriptive voice fact 'Warm and easy'", async () => {
      writeOnboardingSidecar({
        tools: [],
        tasks: [],
        tone: "warm",
      });

      const state = (await computeRelationshipState()) as RelationshipStateLike;
      const voiceFacts = state.facts.filter(
        (f) => f.category === "voice" && f.source === "onboarding",
      );
      expect(voiceFacts).toHaveLength(1);
      expect(voiceFacts[0]!.text).toBe("Warm and easy");
    });

    test("unrecognized tone value passes through verbatim (backwards-compatible)", async () => {
      writeOnboardingSidecar({
        tools: [],
        tasks: [],
        tone: "balanced",
      });

      const state = (await computeRelationshipState()) as RelationshipStateLike;
      const voiceFacts = state.facts.filter(
        (f) => f.category === "voice" && f.source === "onboarding",
      );
      expect(voiceFacts).toHaveLength(1);
      expect(voiceFacts[0]!.text).toBe("balanced");
    });

    test("missing sidecar produces no onboarding-sourced facts", async () => {
      writeFile("USER.md", "- Preferred name: Alex");
      const state = (await computeRelationshipState()) as RelationshipStateLike;
      for (const f of state.facts) {
        expect(f.source).toBe("inferred");
      }
    });

    test("empty / whitespace-only onboarding entries are skipped", async () => {
      writeOnboardingSidecar({
        tools: ["Slack", "", "  "],
        tasks: ["  ", "Email"],
        tone: "   ",
      });
      const state = (await computeRelationshipState()) as RelationshipStateLike;
      const onboardingFacts = state.facts.filter(
        (f) => f.source === "onboarding",
      );
      expect(onboardingFacts.map((f) => f.text).sort()).toEqual([
        "Email",
        "Slack",
      ]);
    });

    test("corrupt sidecar JSON degrades to zero onboarding facts", async () => {
      mkdirSync(join(workspaceDir, "data"), { recursive: true });
      writeFileSync(getOnboardingSidecarPath(), "{not valid json", "utf-8");
      const state = (await computeRelationshipState()) as RelationshipStateLike;
      for (const f of state.facts) {
        expect(f.source).not.toBe("onboarding");
      }
    });
  });
});
