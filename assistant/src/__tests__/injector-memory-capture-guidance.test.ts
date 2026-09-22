/**
 * `memory-capture-guidance` injector: every turn backed by a live conversation
 * is told, from the retrospective eligibility classifier and the memory-write
 * capability `remember` itself refuses under, whether a later memory pass is
 * coming and whether this turn can save memory at all.
 *
 * The plugin config accessor is mocked so each case can flip the memory and
 * retrospective switches without touching the workspace.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Injector, TurnContext } from "../plugins/types.js";

let memoryEnabled = true;
let retrospectiveEnabled = true;
let configThrows = false;

mock.module("../plugins/defaults/memory/config.js", () => ({
  getMemoryConfig: () => {
    if (configThrows) {
      throw new Error("config unavailable");
    }
    return {
      enabled: memoryEnabled,
      retrospective: { enabled: retrospectiveEnabled },
      retrieval: { scratchpadInjection: { enabled: true } },
    };
  },
}));

const { memoryInjectors } =
  await import("../plugins/defaults/memory/injectors.js");
const { DEFAULT_INJECTOR_ORDER } =
  await import("../plugins/defaults/injector-order.js");

function findInjector(name: string): Injector {
  const injector = memoryInjectors.find((candidate) => candidate.name === name);
  if (!injector) {
    throw new Error(`injector '${name}' not registered`);
  }
  return injector;
}

const guidanceInjector = findInjector("memory-capture-guidance");

function makeContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    requestId: "req-test",
    conversationId: "conv-test",
    turnIndex: 0,
    trust: { sourceChannel: "vellum", trustClass: "guardian" },
    conversationType: "standard",
    conversationSource: "user",
    ...overrides,
  };
}

async function produceText(
  overrides: Partial<TurnContext> = {},
): Promise<string> {
  const block = await guidanceInjector.produce(makeContext(overrides));
  if (!block) {
    throw new Error("expected a guidance block");
  }
  return block.text;
}

describe("memory-capture-guidance injector", () => {
  beforeEach(() => {
    memoryEnabled = true;
    retrospectiveEnabled = true;
    configThrows = false;
  });

  test("is a prepend-user-tail block at its documented order", async () => {
    expect(guidanceInjector.order).toBe(
      DEFAULT_INJECTOR_ORDER.memoryCaptureGuidance,
    );
    const block = await guidanceInjector.produce(makeContext());
    expect(block?.id).toBe("memory-capture-guidance");
    expect(block?.placement).toBe("prepend-user-tail");
    expect(block?.text.startsWith("<memory_capture>\n")).toBe(true);
    expect(block?.text.endsWith("\n</memory_capture>")).toBe(true);
  });

  test("a guardian scheduled turn: no later pass, save with remember now", async () => {
    const text = await produceText({ conversationType: "scheduled" });
    expect(text).toContain("No later memory pass reviews this conversation");
    expect(text).toContain("`remember` now");
  });

  test("a guardian consolidation run: no later pass", async () => {
    const text = await produceText({
      conversationType: "background",
      conversationSource: "memory_v2_consolidation",
    });
    expect(text).toContain("No later memory pass reviews this conversation");
  });

  test.each(["standard", "background"])(
    "a guardian %s turn: a later pass is not guaranteed, still save now",
    async (conversationType) => {
      const text = await produceText({ conversationType });
      expect(text).toContain(
        "may review this conversation but is not guaranteed",
      );
      expect(text).toContain("`remember` now");
      expect(text).not.toContain("No later memory pass");
    },
  );

  test("memory off: nothing is saved now or later, and no tool is named", async () => {
    memoryEnabled = false;
    const text = await produceText();
    expect(text).toContain("Memory is off for this assistant");
    expect(text).not.toContain("remember");
  });

  test("retrospective off: no later pass, save with remember now", async () => {
    retrospectiveEnabled = false;
    const text = await produceText();
    expect(text).toContain("No later memory pass reviews this conversation");
    expect(text).toContain("`remember` now");
  });

  test.each(["trusted_contact", "unverified_contact", "unknown"] as const)(
    "a %s turn on a standard conversation: cannot write, triggers no pass",
    async (trustClass) => {
      // Every trigger path gates on the same trust, so the copy may not
      // promise a pass this turn cannot cause. It stays turn-scoped: the
      // guardian may still speak in this conversation and be reviewed.
      const text = await produceText({
        trust: { sourceChannel: "telegram", trustClass },
      });
      expect(text).toContain(
        "You cannot save memory on this turn, and this turn does not trigger a later memory pass.",
      );
      expect(text).not.toContain("remember");
    },
  );

  test("a guardian turn whose surface omits `remember`: cannot write", async () => {
    // Memory consolidation and the researcher and advisor subagent roles run
    // guardian-trust with allowlists that leave the tool out.
    const text = await produceText({ canUseRememberTool: false });
    expect(text).toContain("You cannot save memory on this turn");
    expect(text).not.toContain("remember`");
  });

  test("a guardian turn with the tool present is told to save now", async () => {
    const text = await produceText({ canUseRememberTool: true });
    expect(text).toContain("`remember` now");
  });

  test("a trusted contact on a scheduled conversation: cannot write, no later pass", async () => {
    // The conversation reason outranks the actor reason: a scheduled
    // conversation is never reviewed, whoever is speaking.
    const text = await produceText({
      conversationType: "scheduled",
      trust: { sourceChannel: "telegram", trustClass: "trusted_contact" },
    });
    expect(text).toContain(
      "You cannot save memory on this turn, and no later memory pass",
    );
    expect(text).not.toContain("remember");
  });

  test("renders the same block in minimal mode as in full mode", async () => {
    const full = await produceText({ mode: "full" });
    const minimal = await produceText({ mode: "minimal" });
    expect(minimal).toBe(full);
  });

  test("makes no claim without the conversation fields", async () => {
    expect(
      await guidanceInjector.produce(
        makeContext({ conversationType: undefined }),
      ),
    ).toBeNull();
    expect(
      await guidanceInjector.produce(
        makeContext({ conversationSource: undefined }),
      ),
    ).toBeNull();
  });

  test("an unreadable config counts memory on and the retrospective off", async () => {
    configThrows = true;
    const text = await produceText();
    expect(text).toContain("No later memory pass reviews this conversation");
    expect(text).toContain("`remember` now");
  });
});
