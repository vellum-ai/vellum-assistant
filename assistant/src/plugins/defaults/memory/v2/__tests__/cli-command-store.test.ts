/**
 * Tests for `assistant/src/memory/v2/cli-command-store.ts`.
 *
 * Coverage matrix:
 *   - `seedV2CliCommandEntries` renders one `cli-commands/<name>` point per
 *     declarative command entry (`CLI_COMMAND_HELP`) and upserts it.
 *   - It calls `pruneSlugsWithPrefixExcept("cli-commands/", ...)` with the
 *     current id list under the `cli-command` kind so stale rows clear.
 *   - The legacy `kind` backfill runs once per process before pruning.
 *   - It populates the `entries` cache so `getCliCommandCapability` resolves
 *     both bare names and unified-collection slugs.
 *   - It swallows embedding-backend errors and leaves prior cache intact.
 *   - Stale in-flight results yield to the latest requested generation.
 *
 * Hermetic by design: the embedding backend and Qdrant module are
 * module-mocked, and the declarative command list is staged per test — the
 * seed reads pure data from `@vellumai/plugin-api`, so it never imports the
 * CLI's action graph.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { CliCommandHelp } from "../../../../../cli/lib/cli-command-help.js";

// ---------------------------------------------------------------------------
// Programmable test state
// ---------------------------------------------------------------------------

interface UpsertCall {
  slug: string;
  dense: number[];
  sparse: { indices: number[]; values: number[] };
  updatedAt: number;
  kind?: string;
}

interface PruneCall {
  prefix: string;
  activeSuffixes: readonly string[];
  options?: { kind?: string };
}

interface BackfillCall {
  prefix: string;
  kind: string;
  allowedSuffixes: ReadonlySet<string>;
}

interface TestState {
  commands: CliCommandHelp[];
  embedThrows: Error | null;
  embedReturn: number[][];
  sparseReturn: { indices: number[]; values: number[] };
  upsertCalls: UpsertCall[];
  pruneCalls: PruneCall[];
  upsertThrows: Error | null;
  backfillCalls: BackfillCall[];
  backfillThrows: Error | null;
  callSequence: Array<"upsert" | "prune" | "backfill">;
}

const state: TestState = {
  commands: [],
  embedThrows: null,
  embedReturn: [],
  sparseReturn: { indices: [1], values: [1] },
  upsertCalls: [],
  pruneCalls: [],
  upsertThrows: null,
  backfillCalls: [],
  backfillThrows: null,
  callSequence: [],
};

/** Build a minimal declarative help fixture. */
function help(
  name: string,
  description: string,
  helpText?: string,
): CliCommandHelp {
  return { name, description, ...(helpText ? { helpText } : {}) };
}

/**
 * Stage the declarative command list. Mutates `state.commands` in place so the
 * stable array reference captured by the `cli/index.help.js` mock (below) sees
 * the update — reassigning `state.commands` would not propagate.
 */
function setCommands(...commands: CliCommandHelp[]): void {
  state.commands.length = 0;
  state.commands.push(...commands);
}

// Stage the declarative command list per test. The store imports
// `CLI_COMMAND_HELP` from `@vellumai/plugin-api`, which re-exports it from
// `cli/index.help.js` — mocking that module drives the seed with pure data,
// so no test wires the Commander action graph.
mock.module("../../../../../cli/index.help.js", () => ({
  CLI_COMMAND_HELP: state.commands,
}));

mock.module(
  "../../../../../persistence/embeddings/embedding-backend.js",
  () => ({
    embedWithBackend: async (_config: unknown, inputs: unknown[]) => {
      if (state.embedThrows) throw state.embedThrows;
      const vectors = state.embedReturn.length
        ? state.embedReturn
        : inputs.map(() => [0.1, 0.2, 0.3]);
      return { provider: "local", model: "test-model", vectors };
    },
    generateSparseEmbedding: () => state.sparseReturn,
  }),
);

mock.module("../sparse-bm25.js", () => ({
  generateBm25DocEmbedding: () => state.sparseReturn,
  getConceptPageCorpusStats: () => null,
}));

mock.module("../../../../../memory/v2/anisotropy.js", () => ({
  applyCorrectionIfCalibrated: async (v: number[]) => v,
}));

mock.module("../page-index.js", () => ({
  invalidatePageIndex: () => {},
}));

mock.module("../qdrant.js", () => ({
  upsertConceptPageEmbedding: async (params: UpsertCall) => {
    if (state.upsertThrows) throw state.upsertThrows;
    state.callSequence.push("upsert");
    state.upsertCalls.push(params);
  },
  pruneSlugsWithPrefixExcept: async (
    prefix: string,
    activeSuffixes: readonly string[],
    options?: { kind?: string },
  ) => {
    state.callSequence.push("prune");
    state.pruneCalls.push({ prefix, activeSuffixes, options });
  },
  backfillKindOnPointsWithPrefix: async (
    prefix: string,
    kind: string,
    allowedSuffixes: ReadonlySet<string>,
  ) => {
    if (state.backfillThrows) throw state.backfillThrows;
    state.callSequence.push("backfill");
    state.backfillCalls.push({ prefix, kind, allowedSuffixes });
    return 0;
  },
}));

const {
  seedV2CliCommandEntries,
  getCliCommandCapability,
  listCliCommandEntries,
  isCliCommandSlug,
  _resetCliCommandStoreForTests,
} = await import("../cli-command-store.js");

function resetState(): void {
  state.commands.length = 0;
  state.embedThrows = null;
  state.embedReturn = [];
  state.sparseReturn = { indices: [1], values: [1] };
  state.upsertCalls.length = 0;
  state.pruneCalls.length = 0;
  state.upsertThrows = null;
  state.backfillCalls.length = 0;
  state.backfillThrows = null;
  state.callSequence.length = 0;
  _resetCliCommandStoreForTests();
}

beforeEach(resetState);
afterEach(resetState);

describe("seedV2CliCommandEntries", () => {
  test("upserts each declarative command under cli-commands/<name>", async () => {
    setCommands(
      help("attachment", "Manage file attachments for conversations"),
      help("browser", "Control the browser via the running assistant."),
    );
    state.embedReturn = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ];

    await seedV2CliCommandEntries();

    expect(state.upsertCalls).toHaveLength(2);
    const slugs = state.upsertCalls.map((c) => c.slug).sort();
    expect(slugs).toEqual(["cli-commands/attachment", "cli-commands/browser"]);
    expect(state.upsertCalls.every((c) => c.kind === "cli-command")).toBe(true);
  });

  test("calls pruneSlugsWithPrefixExcept with kind: 'cli-command'", async () => {
    setCommands(help("config", "Manage configuration"));
    state.embedReturn = [[0.1, 0.2, 0.3]];

    await seedV2CliCommandEntries();

    expect(state.pruneCalls).toHaveLength(1);
    expect(state.pruneCalls[0].prefix).toBe("cli-commands/");
    expect([...state.pruneCalls[0].activeSuffixes]).toEqual(["config"]);
    expect(state.pruneCalls[0].options).toEqual({ kind: "cli-command" });
  });

  test("runs backfill before prune so legacy kindless points are reachable", async () => {
    setCommands(help("config", "Manage configuration"));
    state.embedReturn = [[0.1, 0.2, 0.3]];

    await seedV2CliCommandEntries();

    expect(state.backfillCalls).toHaveLength(1);
    expect(state.backfillCalls[0].prefix).toBe("cli-commands/");
    expect(state.backfillCalls[0].kind).toBe("cli-command");
    expect([...state.backfillCalls[0].allowedSuffixes]).toEqual(["config"]);
    expect(state.callSequence.filter((s) => s !== "upsert")).toEqual([
      "backfill",
      "prune",
    ]);
  });

  test("backfill only runs once across repeated seeds in the same process", async () => {
    setCommands(help("config", "Manage configuration"));
    state.embedReturn = [[0.1, 0.2, 0.3]];

    await seedV2CliCommandEntries();
    state.embedReturn = [[0.4, 0.5, 0.6]];
    await seedV2CliCommandEntries();

    expect(state.backfillCalls).toHaveLength(1);
    expect(state.pruneCalls).toHaveLength(2);
  });

  test("populates the entries cache so getCliCommandCapability resolves both forms", async () => {
    setCommands(
      help(
        "attachment",
        "Manage file attachments",
        "Register a file-backed attachment with the assistant",
      ),
    );
    state.embedReturn = [[0.1, 0.2, 0.3]];

    expect(getCliCommandCapability("attachment")).toBeNull();

    await seedV2CliCommandEntries();

    const byId = getCliCommandCapability("attachment");
    const bySlug = getCliCommandCapability("cli-commands/attachment");
    expect(byId).not.toBeNull();
    expect(byId?.id).toBe("attachment");
    expect(byId?.description).toBe("Manage file attachments");
    expect(byId?.content).toContain('"assistant attachment"');
    expect(byId?.content).toContain("Manage file attachments");
    expect(byId?.content).toContain(
      "Register a file-backed attachment with the assistant",
    );
    expect(bySlug).toEqual(byId);

    expect(getCliCommandCapability("unknown-command")).toBeNull();
    expect(getCliCommandCapability("cli-commands/unknown")).toBeNull();
  });

  test("isCliCommandSlug recognises the prefix", () => {
    expect(isCliCommandSlug("cli-commands/attachment")).toBe(true);
    expect(isCliCommandSlug("skills/example")).toBe(false);
    expect(isCliCommandSlug("alice")).toBe(false);
  });

  test("listCliCommandEntries returns frozen sorted snapshots", async () => {
    setCommands(
      help("browser", "Control browser"),
      help("attachment", "Manage attachments"),
    );
    state.embedReturn = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ];

    await seedV2CliCommandEntries();

    const snapshot = listCliCommandEntries();
    expect(snapshot.map((e) => e.id)).toEqual(["attachment", "browser"]);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
  });

  test("swallows embedWithBackend errors and leaves prior cache intact", async () => {
    setCommands(help("config", "Manage configuration"));
    state.embedReturn = [[0.1, 0.2, 0.3]];

    await seedV2CliCommandEntries();
    const before = getCliCommandCapability("config");
    expect(before).not.toBeNull();

    state.upsertCalls.length = 0;
    state.pruneCalls.length = 0;
    state.embedThrows = new Error("backend exploded");

    await expect(seedV2CliCommandEntries()).resolves.toBeUndefined();

    expect(state.upsertCalls).toHaveLength(0);
    expect(state.pruneCalls).toHaveLength(0);
    const after = getCliCommandCapability("config");
    expect(after).toEqual(before);
  });

  test("propagates embedding errors when throwOnError is set", async () => {
    setCommands(help("config", "Manage configuration"));
    state.embedThrows = new Error("backend exploded");

    await expect(
      seedV2CliCommandEntries({ throwOnError: true }),
    ).rejects.toThrow("backend exploded");
  });

  test("populates the cache from the declarative help on the first seed even when the embedding backend is unavailable (cold-start needle resilience)", async () => {
    // Cold-start race: the startup seed runs before the managed embedding
    // credential is provisioned, so the first `embedWithBackend` throws. The
    // in-memory cache (read by the v3 needle lane and the page index) must
    // still populate from the declarative help so CLI commands are
    // discoverable from first boot; only the dense Qdrant upsert is deferred.
    setCommands(help("config", "Manage configuration"));
    state.embedThrows = new Error(
      'Embedding backend "gemini" is not configured',
    );

    await expect(seedV2CliCommandEntries()).resolves.toBeUndefined();

    const entry = getCliCommandCapability("config");
    expect(entry).not.toBeNull();
    expect(entry?.id).toBe("config");
    expect(listCliCommandEntries().map((e) => e.id)).toEqual(["config"]);

    // No dense vectors were produced, so the Qdrant write is skipped entirely.
    expect(state.upsertCalls).toHaveLength(0);
    expect(state.pruneCalls).toHaveLength(0);
  });

  test("skips stale in-flight seed results when a newer refresh is requested", async () => {
    setCommands(help("config", "Manage configuration"));
    state.embedReturn = [[0.1, 0.2, 0.3]];

    const firstSeed = seedV2CliCommandEntries();
    setCommands(help("browser", "Control browser"));
    const secondSeed = seedV2CliCommandEntries();

    await Promise.all([firstSeed, secondSeed]);

    expect(state.upsertCalls.map((c) => c.slug)).toEqual([
      "cli-commands/browser",
    ]);
    expect(getCliCommandCapability("config")).toBeNull();
    expect(getCliCommandCapability("browser")).not.toBeNull();
  });

  test("empty command set still calls prune to clear stale rows", async () => {
    setCommands();

    await seedV2CliCommandEntries();

    expect(state.upsertCalls).toHaveLength(0);
    expect(state.pruneCalls).toHaveLength(1);
    expect(state.pruneCalls[0].activeSuffixes).toEqual([]);
  });
});
