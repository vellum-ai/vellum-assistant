/**
 * Tests for the `memory-v2-static` runtime injector.
 *
 * Covers:
 *   - Returns null when the v2 static memory files are absent/empty.
 *   - Returns null when `mode === "minimal"`.
 *   - Wraps content in `<info>...</info>` and uses
 *     `after-memory-prefix` placement.
 *   - Escapes any `</info>` substring inside the authored content so the
 *     wrapper cannot be broken out of.
 *   - Skips (re)injection when the `<info>` block is already present in the
 *     turn's working messages (presence detection — the block persists in
 *     history between compactions).
 *   - Still injects when only a dynamic `<memory>` activation block is present
 *     (that wrapper must not be mistaken for the static block) — both on a
 *     normal turn and after compaction strips the prior `<info>` block.
 *
 * The injector sources its content itself via `readMemoryV2StaticContent()`
 * behind the personal-memory trust gate, so each test seeds the workspace
 * memory files rather than passing the content in as an option. Mocks
 * `config/loader` so the v2 gates are on without standing up a full config.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realLoader = await import("../config/loader.js");

mock.module("../config/loader.js", () => ({
  ...realLoader,
  loadConfig: () => ({
    memory: { enabled: true, v2: { enabled: true } },
  }),
  getConfig: () => ({
    memory: { enabled: true, v2: { enabled: true } },
  }),
}));

const { defaultInjectors } =
  await import("../plugins/defaults/memory-retrieval/injectors.js");
import type { Injector, TurnContext } from "../plugins/types.js";
import type { Message } from "../providers/types.js";
import { getWorkspacePromptPath } from "../util/platform.js";

function findInjector(name: string): Injector {
  const injector = defaultInjectors.find((i) => i.name === name);
  if (!injector) {
    throw new Error(`injector '${name}' not registered`);
  }
  return injector;
}

function makeContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    requestId: "req-test",
    conversationId: "conv-test",
    turnIndex: 0,
    trust: { sourceChannel: "vellum", trustClass: "guardian" },
    injectionInputs: {},
    ...overrides,
  };
}

/** Seed a single v2 static memory section under `## Essentials`. */
function seedEssentials(body: string): void {
  const path = getWorkspacePromptPath("memory/essentials.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf-8");
}

function seedThreads(body: string): void {
  const path = getWorkspacePromptPath("memory/threads.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf-8");
}

function clearV2StaticFiles(): void {
  for (const file of [
    "memory/essentials.md",
    "memory/threads.md",
    "memory/recent.md",
    "memory/buffer.md",
  ]) {
    rmSync(getWorkspacePromptPath(file), { force: true });
  }
}

const memoryV2StaticInjector = findInjector("memory-v2-static");

describe("memory-v2-static injector", () => {
  beforeEach(() => clearV2StaticFiles());
  afterEach(() => clearV2StaticFiles());

  test("returns null when the v2 static memory files are absent", async () => {
    const ctx = makeContext();
    expect(await memoryV2StaticInjector.produce(ctx)).toBeNull();
  });

  test("returns null in minimal mode even with content", async () => {
    seedEssentials("Alice prefers VS Code.");
    const ctx = makeContext({ injectionInputs: { mode: "minimal" } });
    expect(await memoryV2StaticInjector.produce(ctx)).toBeNull();
  });

  test("wraps content in <info>...</info> with after-memory-prefix placement", async () => {
    seedEssentials("Alice prefers VS Code.");
    seedThreads("Open: ship PR.");
    const ctx = makeContext();

    const block = await memoryV2StaticInjector.produce(ctx);
    expect(block).not.toBeNull();
    expect(block!.id).toBe("memory-v2-static");
    expect(block!.placement).toBe("after-memory-prefix");
    expect(block!.text).toBe(
      "<info>\n## Essentials\n\nAlice prefers VS Code.\n\n## Threads\n\nOpen: ship PR.\n</info>",
    );
  });

  test("escapes inner </info> closing tags so the wrapper cannot be broken out of", async () => {
    seedEssentials("Text with </info> embedded.");
    const ctx = makeContext();

    const block = await memoryV2StaticInjector.produce(ctx);
    expect(block).not.toBeNull();
    expect(block!.text).toBe(
      "<info>\n## Essentials\n\nText with &lt;/info&gt; embedded.\n</info>",
    );
  });

  test("skips (re)injection when the <info> block is already present", async () => {
    seedEssentials("Alice prefers VS Code.");
    const ctx = makeContext();
    const runMessages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "<info>\nstale memory\n</info>" },
          { type: "text", text: "What next?" },
        ],
      },
    ];
    expect(await memoryV2StaticInjector.produce(ctx, runMessages)).toBeNull();
  });

  test("injects the <info> block even when a dynamic <memory> activation block is present", async () => {
    // Regression (#33612): the v2 *dynamic* activation block uses the
    // `<memory>…</memory>` wrapper and `prepareMemory` prepends it to the tail
    // user message every turn, before this injector runs. The static injector
    // must NOT treat that as its own `<info>` block — doing so suppressed the
    // static block on essentially every turn.
    seedEssentials("Alice prefers VS Code.");
    const ctx = makeContext();
    const runMessages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<memory>\n# memory/concepts/foo.md\nactivated page summary\n</memory>",
          },
          { type: "text", text: "What next?" },
        ],
      },
    ];
    const block = await memoryV2StaticInjector.produce(ctx, runMessages);
    expect(block).not.toBeNull();
    expect(block!.id).toBe("memory-v2-static");
    expect(block!.text).toBe(
      "<info>\n## Essentials\n\nAlice prefers VS Code.\n</info>",
    );
  });

  test("reinjects the <info> block after compaction strips it, alongside a fresh <memory> block", async () => {
    // Post-compaction state: `stripInjectionsForCompaction` removed the prior
    // `<info>` block, and the next turn's `prepareMemory` re-added a fresh
    // dynamic `<memory>` block ahead of the chain. With no `<info>` present, the
    // injector must reinject it rather than skip on the `<memory>` block.
    seedEssentials("Alice prefers VS Code.");
    const ctx = makeContext();
    const postCompactMessages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "<memory>\nactivated page summary\n</memory>" },
          { type: "text", text: "Continue please." },
        ],
      },
    ];
    const block = await memoryV2StaticInjector.produce(
      ctx,
      postCompactMessages,
    );
    expect(block).not.toBeNull();
    expect(block!.id).toBe("memory-v2-static");
    expect(block!.text).toContain("## Essentials");
  });
});
