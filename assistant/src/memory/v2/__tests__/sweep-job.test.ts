/**
 * Tests for `assistant/src/memory/v2/sweep-job.ts`.
 *
 * Coverage matrix:
 *   - v2 disabled in config → no provider/DB calls, returns 0 (early bail).
 *   - sweep_enabled off → no provider call, returns 0.
 *   - v2 on + no recent messages → no provider call, returns 0.
 *   - v2 on + recent messages → provider invoked with rendered prompt;
 *     each entry is appended to `memory/buffer.md` AND today's archive.
 *   - Tool-call response shape mismatch → returns 0 without writes.
 *   - Empty entries are skipped (the model can't pad the buffer).
 *
 * Tests use temp workspaces (mkdtemp) and never touch `~/.vellum/`. Sample
 * content uses generic placeholders (Alice, Bob, user@example.com).
 */
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
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { makeMockLogger } from "../../../__tests__/helpers/mock-logger.js";
import type {
  Provider,
  ProviderResponse,
  ToolUseContent,
} from "../../../providers/types.js";

mock.module("../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

// Provider stub. Each test sets `providerStub` to control the response;
// `null` simulates "no configured provider".
let providerStub: Provider | null = null;
const providerCalls: Array<{
  systemPrompt: string | undefined;
  userText: string;
}> = [];

mock.module("../../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => providerStub,
  userMessage: (text: string) => ({
    role: "user" as const,
    content: [{ type: "text" as const, text }],
  }),
  extractToolUse: (response: ProviderResponse) =>
    response.content.find((b): b is ToolUseContent => b.type === "tool_use"),
}));

// Workspace setup — temp dir per test run, pinned via VELLUM_WORKSPACE_DIR
// so `getWorkspaceDir()` resolves to the tmpdir.
let tmpWorkspace: string;
let previousWorkspaceEnv: string | undefined;

beforeAll(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "memory-v2-sweep-test-"));
  previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;
});

afterAll(() => {
  if (previousWorkspaceEnv === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
  }
  rmSync(tmpWorkspace, { recursive: true, force: true });
});

const { resetDb, getDb } = await import("../../db-connection.js");
const { initializeDb } = await import("../../db-init.js");
const { messages, conversations } = await import("../../schema.js");
const { memoryV2SweepJob } = await import("../sweep-job.js");

// The handler reads `config.memory.v2.enabled` and `sweep_enabled`, so we
// hand it a minimal stand-in instead of materializing the full default
// config — which would otherwise pull in heavy schemas this test doesn't
// exercise.
const CONFIG = {
  memory: { v2: { enabled: true, sweep_enabled: true } },
} as Parameters<typeof memoryV2SweepJob>[1];
const CONFIG_V2_OFF = {
  memory: { v2: { enabled: false, sweep_enabled: true } },
} as Parameters<typeof memoryV2SweepJob>[1];
const CONFIG_SWEEP_OFF = {
  memory: { v2: { enabled: true, sweep_enabled: false } },
} as Parameters<typeof memoryV2SweepJob>[1];

function makeJob(): Parameters<typeof memoryV2SweepJob>[0] {
  return {
    id: "sweep-1",
    type: "memory_v2_sweep",
    payload: {},
    status: "running",
    attempts: 0,
    deferrals: 0,
    runAfter: 0,
    lastError: null,
    startedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Tool-shape provider stub. Returns a single `tool_use` block whose `input`
 * matches `{ entries: [...] }` so the sweep's parser accepts it.
 */
function makeEntriesProvider(entries: string[]): Provider {
  return {
    name: "stub",
    sendMessage: async (msgs, _tools, systemPrompt) => {
      providerCalls.push({
        systemPrompt,
        userText: extractFirstUserText(msgs),
      });
      return {
        model: "stub-model",
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "emit_remember_entries",
            input: { entries },
          },
        ],
      } satisfies ProviderResponse;
    },
  };
}

/**
 * Extract the first text block of the first user message — keeps the test
 * assertions readable when only one user message is in flight.
 */
function extractFirstUserText(msgs: { content: unknown }[]): string {
  const first = msgs[0];
  if (!first || !Array.isArray(first.content)) return "";
  const block = first.content.find(
    (b: unknown) =>
      typeof b === "object" &&
      b !== null &&
      (b as { type?: string }).type === "text",
  ) as { text?: string } | undefined;
  return block?.text ?? "";
}

/** Insert a conversation + N messages, with createdAt offsets in ms relative to now. */
function seedMessages(
  conversationId: string,
  rows: Array<{ role: string; content: string; offsetMs: number }>,
  conversationType: "standard" | "background" | "scheduled" = "standard",
): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id: conversationId,
      title: null,
      createdAt: now - 60_000,
      updatedAt: now,
      conversationType,
    })
    .run();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    db.insert(messages)
      .values({
        id: `${conversationId}-msg-${i}`,
        conversationId,
        role: row.role,
        content: row.content,
        createdAt: now + row.offsetMs,
        metadata: null,
      })
      .run();
  }
}

beforeEach(() => {
  resetDb();
  initializeDb();
  // Fresh memory dir per test — keeps assertions on file contents independent.
  rmSync(join(tmpWorkspace, "memory"), { recursive: true, force: true });
  mkdirSync(join(tmpWorkspace, "memory"), { recursive: true });
  providerCalls.length = 0;
  providerStub = null;
});

// ---------------------------------------------------------------------------

describe("memoryV2SweepJob — v2 disabled", () => {
  test("returns 0 without invoking the provider when memory.v2.enabled is false", async () => {
    providerStub = makeEntriesProvider(["should-not-be-written"]);

    const written = await memoryV2SweepJob(makeJob(), CONFIG_V2_OFF);

    expect(written).toBe(0);
    expect(providerCalls).toHaveLength(0);
    expect(existsSync(join(tmpWorkspace, "memory", "buffer.md"))).toBe(false);
  });
});

describe("memoryV2SweepJob — sweep_enabled off", () => {
  test("returns 0 without invoking the provider when sweep_enabled is false", async () => {
    // No message seeding required — the sweep_enabled bail short-circuits
    // before any DB or workspace reads.
    providerStub = makeEntriesProvider(["should-not-be-written"]);

    const written = await memoryV2SweepJob(makeJob(), CONFIG_SWEEP_OFF);

    expect(written).toBe(0);
    expect(providerCalls).toHaveLength(0);
    expect(existsSync(join(tmpWorkspace, "memory", "buffer.md"))).toBe(false);
  });
});

describe("memoryV2SweepJob — no recent messages", () => {
  test("returns 0 when no messages exist in the recent window", async () => {
    providerStub = makeEntriesProvider(["should-not-be-written"]);

    const written = await memoryV2SweepJob(makeJob(), CONFIG);

    expect(written).toBe(0);
    expect(providerCalls).toHaveLength(0);
  });

  test("returns 0 when messages exist but are all outside the 30m window", async () => {
    seedMessages("conv-old", [
      { role: "user", content: "Hello.", offsetMs: -60 * 60 * 1000 }, // 1h ago
      { role: "assistant", content: "Hi!", offsetMs: -59 * 60 * 1000 },
    ]);
    providerStub = makeEntriesProvider(["should-not-be-written"]);

    const written = await memoryV2SweepJob(makeJob(), CONFIG);

    expect(written).toBe(0);
    expect(providerCalls).toHaveLength(0);
  });
});

// Per-test conversation id ensures each test seeds a row that doesn't
// collide with the previous test's row in the (shared) test DB. `resetDb`
// is called in the outer beforeEach, but bun's mock module flow keeps the
// DB intact long enough for the SQL inserts here to clash.
let convCounter = 0;

describe("memoryV2SweepJob — recent messages", () => {
  beforeEach(() => {
    seedMessages(`conv-${++convCounter}`, [
      {
        role: "user",
        content: "I just switched my editor to VS Code.",
        offsetMs: -60_000,
      },
      {
        role: "assistant",
        content: "Got it — VS Code it is.",
        offsetMs: -30_000,
      },
    ]);
  });

  test("appends each returned entry to buffer.md and today's archive", async () => {
    providerStub = makeEntriesProvider([
      "Alice prefers VS Code over Vim.",
      "Alice ships at end of day.",
    ]);

    const written = await memoryV2SweepJob(makeJob(), CONFIG);

    expect(written).toBe(2);
    expect(providerCalls).toHaveLength(1);

    const buffer = readFileSync(
      join(tmpWorkspace, "memory", "buffer.md"),
      "utf-8",
    );
    expect(buffer).toContain("Alice prefers VS Code over Vim.");
    expect(buffer).toContain("Alice ships at end of day.");

    const archivePath = join(
      tmpWorkspace,
      "memory",
      "archive",
      todaysArchiveBasename(),
    );
    expect(existsSync(archivePath)).toBe(true);
    const archive = readFileSync(archivePath, "utf-8");
    expect(archive).toContain("Alice prefers VS Code over Vim.");
    expect(archive).toContain("Alice ships at end of day.");
  });

  test("renders system prompt with assistant + user names from IDENTITY/persona", async () => {
    // The IDENTITY / persona files use markdown-bold name labels — the
    // production prompt-resolver greps for the same shape, so we have to
    // emit a literal markdown-bold "Name" marker here.
    const NAME_LABEL = `**${"Name"}:**`;
    writeFileSync(
      join(tmpWorkspace, "IDENTITY.md"),
      `${NAME_LABEL} Aria\n`,
      "utf-8",
    );
    mkdirSync(join(tmpWorkspace, "users"), { recursive: true });
    writeFileSync(
      join(tmpWorkspace, "users", "default.md"),
      `${NAME_LABEL} Alice\n`,
      "utf-8",
    );

    providerStub = makeEntriesProvider(["entry"]);
    await memoryV2SweepJob(makeJob(), CONFIG);

    expect(providerCalls).toHaveLength(1);
    const [{ systemPrompt }] = providerCalls;
    expect(systemPrompt).toContain("Aria");
    expect(systemPrompt).toContain("Alice");
  });

  test("hands the model the existing buffer for dedup", async () => {
    writeFileSync(
      join(tmpWorkspace, "memory", "buffer.md"),
      "- [Apr 27, 9:00 AM] Existing entry that should be referenced as dedup signal.\n",
      "utf-8",
    );

    providerStub = makeEntriesProvider(["new entry"]);
    await memoryV2SweepJob(makeJob(), CONFIG);

    expect(providerCalls).toHaveLength(1);
    const [{ userText }] = providerCalls;
    expect(userText).toContain("existingBuffer");
    expect(userText).toContain("Existing entry that should be referenced");
  });

  test("skips empty / whitespace-only entries the model returns", async () => {
    providerStub = makeEntriesProvider([
      "Alice prefers VS Code.",
      "",
      "   ",
      "Alice ships at end of day.",
    ]);

    const written = await memoryV2SweepJob(makeJob(), CONFIG);

    expect(written).toBe(2);
    const buffer = readFileSync(
      join(tmpWorkspace, "memory", "buffer.md"),
      "utf-8",
    );
    // Two timestamped bullets — count newlines that start with "- ".
    const bullets = buffer.split("\n").filter((line) => line.startsWith("- "));
    expect(bullets).toHaveLength(2);
  });

  test("returns 0 when the model returns no tool_use block", async () => {
    providerStub = {
      name: "no-tool",
      sendMessage: async () => ({
        model: "stub-model",
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
        content: [{ type: "text", text: "I have nothing to add." }],
      }),
    };

    const written = await memoryV2SweepJob(makeJob(), CONFIG);

    expect(written).toBe(0);
    expect(existsSync(join(tmpWorkspace, "memory", "buffer.md"))).toBe(false);
  });

  test("returns 0 when the tool input is malformed", async () => {
    providerStub = {
      name: "bad-shape",
      sendMessage: async () => ({
        model: "stub-model",
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "emit_remember_entries",
            // Missing `entries` array — schema rejects.
            input: { other: "shape" },
          },
        ],
      }),
    };

    const written = await memoryV2SweepJob(makeJob(), CONFIG);

    expect(written).toBe(0);
    expect(existsSync(join(tmpWorkspace, "memory", "buffer.md"))).toBe(false);
  });

  test("returns 0 when no provider is configured", async () => {
    providerStub = null;

    const written = await memoryV2SweepJob(makeJob(), CONFIG);

    expect(written).toBe(0);
  });
});

describe("memoryV2SweepJob — background/scheduled conversation filter", () => {
  test("excludes background/scheduled conversation content from sweep input", async () => {
    seedMessages(
      `conv-bg-${++convCounter}`,
      [
        {
          role: "assistant",
          content:
            "[heartbeat] internal automation chatter that should not leak",
          offsetMs: -60_000,
        },
      ],
      "background",
    );
    seedMessages(
      `conv-sched-${++convCounter}`,
      [
        {
          role: "assistant",
          content:
            "[scheduled] scheduled-job chatter that should not leak either",
          offsetMs: -45_000,
        },
      ],
      "scheduled",
    );
    seedMessages(`conv-user-${++convCounter}`, [
      {
        role: "user",
        content: "Bob mentioned he prefers dark mode.",
        offsetMs: -30_000,
      },
    ]);

    providerStub = makeEntriesProvider(["Bob prefers dark mode."]);

    const written = await memoryV2SweepJob(makeJob(), CONFIG);

    expect(written).toBe(1);
    expect(providerCalls).toHaveLength(1);
    const [{ userText }] = providerCalls;
    expect(userText).toContain("Bob mentioned he prefers dark mode.");
    expect(userText).not.toContain("internal automation chatter");
    expect(userText).not.toContain("scheduled-job chatter");
  });
});

function todaysArchiveBasename(now: Date = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}.md`;
}
