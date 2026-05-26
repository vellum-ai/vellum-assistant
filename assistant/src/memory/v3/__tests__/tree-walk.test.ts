/**
 * Tests for `assistant/src/memory/v3/tree-walk.ts`.
 *
 * The descent provider is always a scripted stub injected via the `provider`
 * arg — no real LLM, no network, no `mock.module`, `~/.vellum/` untouched. The
 * stub keys its scripted decision off the `<node id="...">` marker in the user
 * message so one fixture provider can drive a whole multi-node walk with one
 * call per visited node.
 *
 * Coverage:
 *   - scripted descent over a fixture tree collects the right leaf pages and
 *     records considered/descended/skipped + reasoning per node.
 *   - one descent call per *visited* node (not per offered child).
 *   - breadthBudget caps descents per node (skip the overflow).
 *   - maxDepth halts the walk.
 *   - scout page hits seed the start node set (deriveSeedNodes) so a subtree the
 *     root never reaches is still walked.
 *   - explicit seeds bias the start set.
 *   - scout hits are rendered into the descend prompt as pressure.
 *   - provider === null → fail-safe: descend nothing, walk still terminates and
 *     collects the pages it reached, reasoning records the failure.
 *   - leaf nodes (no node children) make no provider call.
 *   - request shape: forced tool_choice on `choose_branches`, abort signal
 *     forwarded.
 */

import { describe, expect, test } from "bun:test";

import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../../../providers/types.js";
import type { RetrievalInput } from "../../v2/harness/retriever.js";
import type { ScoutResult } from "../../v2/harness/trace.js";
import type { PageIndex } from "../../v2/page-index.js";
import { DESCENT_SYSTEM_PROMPT } from "../prompts/system-prompts.js";
import type { ChildRef, TreeIndex } from "../tree-index.js";
import { createDescender, deriveSeedNodes, runTreeWalk } from "../tree-walk.js";
import type { TreeNode } from "../types.js";

// ---------------------------------------------------------------------------
// Fixture helpers.
// ---------------------------------------------------------------------------

function page(ref: string): ChildRef {
  return { kind: "page", ref };
}

function node(ref: string): ChildRef {
  return { kind: "node", ref };
}

interface ProviderCall {
  messages: Message[];
  tools: ToolDefinition[] | undefined;
  systemPrompt: string | undefined;
  options: SendMessageOptions | undefined;
}

/**
 * Build a tree node with the given children refs. `summary` defaults to the id
 * so `composeNodeIndex` produces deterministic, inspectable lines.
 */
function makeNode(id: string, children: ChildRef[]): TreeNode {
  return {
    id,
    frontmatter: {
      children: children.map((c) => `${c.kind}:${c.ref}`),
      summary: `summary of ${id}`,
    },
    body: "",
  };
}

/**
 * Build an in-memory `TreeIndex` from a forward-adjacency spec, materializing
 * `nodes`, `childrenByNode`, and the `pageParents` reverse edges (the only maps
 * `tree-walk.ts` reads). `parentsByNode` is left empty — the driver never reads
 * it.
 */
function makeTree(
  root: string,
  childrenByNode: Record<string, ChildRef[]>,
): TreeIndex {
  const nodes = new Map<string, TreeNode>();
  const children = new Map<string, ReadonlyArray<ChildRef>>();
  const pageParents = new Map<string, Set<string>>();
  for (const [id, refs] of Object.entries(childrenByNode)) {
    nodes.set(id, makeNode(id, refs));
    children.set(id, refs);
    for (const ref of refs) {
      if (ref.kind !== "page") continue;
      let parents = pageParents.get(ref.ref);
      if (!parents) {
        parents = new Set();
        pageParents.set(ref.ref, parents);
      }
      parents.add(id);
    }
  }
  return {
    nodes,
    childrenByNode: children,
    parentsByNode: new Map(),
    pageParents,
    root,
  };
}

/** Empty page index — the driver only needs `bySlug` for page summaries. */
function makePages(slugs: string[]): PageIndex {
  const bySlug = new Map();
  const byId = new Map();
  let id = 1;
  for (const slug of slugs) {
    const entry = {
      id,
      slug,
      summary: `summary of ${slug}`,
      edges: [],
      modifiedAt: 0,
    };
    bySlug.set(slug, entry);
    byId.set(id, entry);
    id++;
  }
  return { entries: [...bySlug.values()], bySlug, byId, rendered: "" };
}

/** Minimal `RetrievalInput` carrying just the fields the driver reads. */
function makeInput(
  overrides?: Partial<RetrievalInput> & {
    breadthBudget?: number;
    maxDepth?: number;
    /** Inline override for `memory.v3.prompts.descent`. */
    descentOverride?: string;
  },
): RetrievalInput {
  const breadthBudget = overrides?.breadthBudget ?? 8;
  const maxDepth = overrides?.maxDepth ?? 8;
  const config = {
    memory: {
      v3: {
        breadthBudget,
        maxDepth,
        ...(overrides?.descentOverride !== undefined
          ? {
              prompts: {
                descent: { override: overrides.descentOverride, path: null },
              },
            }
          : {}),
      },
    },
  } as unknown as RetrievalInput["config"];
  const {
    breadthBudget: _b,
    maxDepth: _m,
    descentOverride: _d,
    ...rest
  } = overrides ?? {};
  return {
    workspaceDir: "/tmp/does-not-matter",
    recentTurnPairs: [{ assistantMessage: "", userMessage: "tell me about a" }],
    nowText: "2026-05-25 10:00 PT",
    priorEverInjected: [],
    config,
    ...rest,
  };
}

/** Pull the `<node id="...">` id out of a recorded descend prompt. */
function nodeIdFromCall(call: ProviderCall): string | null {
  for (const block of call.messages[0]?.content ?? []) {
    if (block.type !== "text") continue;
    const match = block.text.match(/<node id="([^"]*)">/);
    if (match) return match[1];
  }
  return null;
}

/**
 * A scripted descent provider. `script` maps a node id to the bare child-node
 * ids to descend (and an optional reasoning string). Records every call and
 * honors an already-aborted signal by throwing.
 */
function makeProvider(
  script: Record<string, { descend: string[]; reasoning?: string }>,
  calls: ProviderCall[],
): Provider {
  return {
    name: "stub",
    sendMessage: async (messages, tools, systemPrompt, options) => {
      calls.push({ messages, tools, systemPrompt, options });
      if (options?.signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      const nodeId =
        nodeIdFromCall({ messages, tools, systemPrompt, options }) ?? "";
      const decision = script[nodeId] ?? { descend: [] };
      const input: Record<string, unknown> = { descend: decision.descend };
      if (decision.reasoning !== undefined)
        input.reasoning = decision.reasoning;
      const response: ProviderResponse = {
        model: "stub-model",
        stopReason: "tool_use",
        usage: { inputTokens: 0, outputTokens: 0 },
        content: [
          {
            type: "tool_use",
            id: `tu-${nodeId}`,
            name: "choose_branches",
            input,
          },
        ],
      };
      return response;
    },
  };
}

// ---------------------------------------------------------------------------
// deriveSeedNodes
// ---------------------------------------------------------------------------

describe("deriveSeedNodes", () => {
  test("maps scout page slugs to their parent nodes via pageParents", () => {
    const tree = makeTree("_root", {
      _root: [node("a"), node("b")],
      a: [page("pa")],
      b: [page("pb")],
    });
    const scouts: ScoutResult[] = [{ lane: "sparse", slugs: ["pb"] }];
    expect(deriveSeedNodes(tree, scouts, [])).toEqual(["b"]);
  });

  test("unions explicit seeds first, then scout-derived parents, dedup'd", () => {
    const tree = makeTree("_root", {
      _root: [node("a")],
      a: [page("pa")],
    });
    const scouts: ScoutResult[] = [{ lane: "hot", slugs: ["pa", "pa"] }];
    // "a" is both an explicit seed and the parent of pa — appears once, seeds first.
    expect(deriveSeedNodes(tree, scouts, ["a", "x"])).toEqual(["a", "x"]);
  });

  test("ignores scout slugs with no parent node", () => {
    const tree = makeTree("_root", { _root: [page("pr")] });
    const scouts: ScoutResult[] = [{ lane: "dense", slugs: ["orphan"] }];
    expect(deriveSeedNodes(tree, scouts, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runTreeWalk — scripted descent
// ---------------------------------------------------------------------------

describe("runTreeWalk — scripted descent", () => {
  test("collects the right leaf pages and records the descend/skip split", async () => {
    // _root → {a, b}; a → leaf pa; b → leaf pb. Script descends only "a".
    const tree = makeTree("_root", {
      _root: [node("a"), node("b")],
      a: [page("pa")],
      b: [page("pb")],
    });
    const pages = makePages(["pa", "pb"]);
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      { _root: { descend: ["a"], reasoning: "a matches the turn" } },
      calls,
    );

    const { pages: collected, levels } = await runTreeWalk({
      input: makeInput(),
      tree,
      pages,
      scouts: [],
      seeds: [],
      provider,
    });

    // Only the descended branch's page is collected.
    expect([...collected]).toEqual(["pa"]);

    const rootLevel = levels.find((l) => l.node === "_root")!;
    expect(rootLevel.considered).toEqual(["a", "b"]);
    expect(rootLevel.descended).toEqual(["a"]);
    expect(rootLevel.skipped).toEqual(["b"]);
    expect(rootLevel.reasoning).toBe("a matches the turn");

    // _root walked (has node children) + a walked (leaf, no call). b skipped.
    expect(levels.map((l) => l.node).sort()).toEqual(["_root", "a"]);
  });

  test("makes exactly one descent call per visited node with node children", async () => {
    const tree = makeTree("_root", {
      _root: [node("a"), node("b")],
      a: [node("c"), page("pa")],
      b: [page("pb")],
      c: [page("pc")],
    });
    const pages = makePages(["pa", "pb", "pc"]);
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      {
        _root: { descend: ["a", "b"] },
        a: { descend: ["c"] },
        // b and c are leaves of the descended set; c has no node children.
      },
      calls,
    );

    await runTreeWalk({
      input: makeInput(),
      tree,
      pages,
      scouts: [],
      seeds: [],
      provider,
    });

    // Calls happen for nodes that HAVE node children: _root, a. b (leaf) and
    // c (leaf) are visited but short-circuit before the provider call.
    const calledNodes = calls.map(nodeIdFromCall).sort();
    expect(calledNodes).toEqual(["_root", "a"]);
  });

  test("breadthBudget caps descents per node", async () => {
    const tree = makeTree("_root", {
      _root: [node("a"), node("b"), node("c")],
      a: [page("pa")],
      b: [page("pb")],
      c: [page("pc")],
    });
    const pages = makePages(["pa", "pb", "pc"]);
    const calls: ProviderCall[] = [];
    // Model picks all three; budget 2 admits only the first two.
    const provider = makeProvider(
      { _root: { descend: ["a", "b", "c"] } },
      calls,
    );

    const { pages: collected, levels } = await runTreeWalk({
      input: makeInput({ breadthBudget: 2 }),
      tree,
      pages,
      scouts: [],
      seeds: [],
      provider,
    });

    const rootLevel = levels.find((l) => l.node === "_root")!;
    expect(rootLevel.descended).toEqual(["a", "b"]);
    expect(rootLevel.skipped).toEqual(["c"]);
    expect([...collected].sort()).toEqual(["pa", "pb"]);
  });

  test("maxDepth halts the walk", async () => {
    const tree = makeTree("_root", {
      _root: [node("a")],
      a: [node("b"), page("pa")],
      b: [page("pb")],
    });
    const pages = makePages(["pa", "pb"]);
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      { _root: { descend: ["a"] }, a: { descend: ["b"] } },
      calls,
    );

    const { pages: collected, levels } = await runTreeWalk({
      input: makeInput({ maxDepth: 1 }),
      tree,
      pages,
      scouts: [],
      seeds: [],
      provider,
    });

    // Depth 0 (_root) and depth 1 (a) walked; b never reached.
    expect(levels.map((l) => l.node)).toEqual(["_root", "a"]);
    expect([...collected]).toEqual(["pa"]);
  });
});

// ---------------------------------------------------------------------------
// runTreeWalk — scout seeding
// ---------------------------------------------------------------------------

describe("runTreeWalk — scout seeding", () => {
  test("scout page hits seed a subtree the root never reaches", async () => {
    // root only links to a; the "island" subtree is unreachable from root but a
    // scout surfaced its leaf page, so deriveSeedNodes seeds `island`.
    const tree = makeTree("_root", {
      _root: [node("a")],
      a: [page("pa")],
      island: [page("treasure")],
    });
    const pages = makePages(["pa", "treasure"]);
    const calls: ProviderCall[] = [];
    const provider = makeProvider({ _root: { descend: ["a"] } }, calls);

    const scouts: ScoutResult[] = [{ lane: "dense", slugs: ["treasure"] }];
    const { pages: collected, levels } = await runTreeWalk({
      input: makeInput(),
      tree,
      pages,
      scouts,
      seeds: [],
      provider,
    });

    // Both the root branch (pa) and the scout-seeded island (treasure) reached.
    expect([...collected].sort()).toEqual(["pa", "treasure"]);
    expect(levels.map((l) => l.node).sort()).toEqual(["_root", "a", "island"]);
  });

  test("explicit seeds bias the start set", async () => {
    const tree = makeTree("_root", {
      _root: [page("pr")],
      mid: [page("pm")],
    });
    const pages = makePages(["pr", "pm"]);
    const calls: ProviderCall[] = [];
    const provider = makeProvider({}, calls);

    const { pages: collected, levels } = await runTreeWalk({
      input: makeInput(),
      tree,
      pages,
      scouts: [],
      seeds: ["mid"],
      provider,
    });

    expect([...collected].sort()).toEqual(["pm", "pr"]);
    expect(levels.map((l) => l.node).sort()).toEqual(["_root", "mid"]);
  });

  test("renders scout hits into the descend prompt as pressure", async () => {
    const tree = makeTree("_root", {
      _root: [node("a"), node("b")],
      a: [page("pa")],
      b: [page("pb")],
    });
    const pages = makePages(["pa", "pb"]);
    const calls: ProviderCall[] = [];
    const provider = makeProvider({ _root: { descend: ["a"] } }, calls);

    const scouts: ScoutResult[] = [{ lane: "sparse", slugs: ["pb"] }];
    await runTreeWalk({
      input: makeInput(),
      tree,
      pages,
      // Pass scouts but no parent-seed match so the start set stays root-only;
      // we only assert the prompt rendering here.
      scouts,
      seeds: [],
      provider,
    });

    const rootCall = calls.find((c) => nodeIdFromCall(c) === "_root")!;
    const promptText = rootCall.messages[0].content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");
    expect(promptText).toContain("<scout_hits>");
    expect(promptText).toContain("[sparse]: pb");
  });
});

// ---------------------------------------------------------------------------
// runTreeWalk — fail-safe + request shape
// ---------------------------------------------------------------------------

describe("runTreeWalk — fail-safe", () => {
  test("provider null descends nothing but still terminates and collects reached pages", async () => {
    const tree = makeTree("_root", {
      _root: [node("a"), page("pr")],
      a: [page("pa")],
    });
    const pages = makePages(["pr", "pa"]);

    const { pages: collected, levels } = await runTreeWalk({
      input: makeInput(),
      tree,
      pages,
      scouts: [],
      seeds: [],
      provider: null,
    });

    // Root's own page is collected; the undescended branch's page is not.
    expect([...collected]).toEqual(["pr"]);
    expect(levels.map((l) => l.node)).toEqual(["_root"]);
    const rootLevel = levels[0];
    expect(rootLevel.descended).toEqual([]);
    expect(rootLevel.skipped).toEqual(["a"]);
    expect(rootLevel.reasoning).toContain("no provider");
  });

  test("malformed tool input fails closed for that node", async () => {
    const tree = makeTree("_root", {
      _root: [node("a")],
      a: [page("pa")],
    });
    const pages = makePages(["pa"]);
    const calls: ProviderCall[] = [];
    // Provider returns a non-conforming tool input (descend is not an array).
    const provider: Provider = {
      name: "bad-schema",
      sendMessage: async (messages, tools, systemPrompt, options) => {
        calls.push({ messages, tools, systemPrompt, options });
        return {
          model: "stub-model",
          stopReason: "tool_use",
          usage: { inputTokens: 0, outputTokens: 0 },
          content: [
            {
              type: "tool_use",
              id: "tu-1",
              name: "choose_branches",
              input: { descend: "not-an-array" },
            },
          ],
        };
      },
    };

    const { levels } = await runTreeWalk({
      input: makeInput(),
      tree,
      pages,
      scouts: [],
      seeds: [],
      provider,
    });

    const rootLevel = levels.find((l) => l.node === "_root")!;
    expect(rootLevel.descended).toEqual([]);
    expect(rootLevel.reasoning).toContain("validation");
  });
});

describe("createDescender — request shape", () => {
  test("forces tool_choice on choose_branches and forwards the abort signal", async () => {
    const tree = makeTree("_root", {
      _root: [node("a")],
      a: [page("pa")],
    });
    const pages = makePages(["pa"]);
    const calls: ProviderCall[] = [];
    const provider = makeProvider({ _root: { descend: ["a"] } }, calls);

    const reasoningByNode = new Map<string, string>();
    const descender = createDescender(
      {
        input: makeInput({ signal: AbortSignal.timeout(10_000) }),
        tree,
        pages,
        scouts: [],
        seeds: [],
        provider,
      },
      reasoningByNode,
    );

    await descender("_root", [...tree.childrenByNode.get("_root")!]);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.tools?.[0]?.name).toBe("choose_branches");
    expect(call.options?.config?.tool_choice).toEqual({
      type: "tool",
      name: "choose_branches",
    });
    expect(call.options?.config?.callSite).toBe("memoryV3Descent");
    expect(call.options?.signal).toBeDefined();
  });

  test("a node with no node children makes no provider call", async () => {
    const tree = makeTree("leaf", { leaf: [page("p")] });
    const pages = makePages(["p"]);
    const calls: ProviderCall[] = [];
    const provider = makeProvider({}, calls);

    const reasoningByNode = new Map<string, string>();
    const descender = createDescender(
      { input: makeInput(), tree, pages, scouts: [], seeds: [], provider },
      reasoningByNode,
    );

    const chosen = await descender("leaf", [
      ...tree.childrenByNode.get("leaf")!,
    ]);
    expect(chosen).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(reasoningByNode.get("leaf")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// runTreeWalk — descent system prompt
// ---------------------------------------------------------------------------

describe("runTreeWalk — descent system prompt", () => {
  const tree = makeTree("_root", {
    _root: [node("a")],
    a: [page("pa")],
  });

  test("uses the bundled default when no override is configured", async () => {
    const pages = makePages(["pa"]);
    const calls: ProviderCall[] = [];
    const provider = makeProvider({ _root: { descend: ["a"] } }, calls);

    await runTreeWalk({
      input: makeInput(),
      tree,
      pages,
      scouts: [],
      seeds: [],
      provider,
    });

    const rootCall = calls.find((c) => nodeIdFromCall(c) === "_root")!;
    expect(rootCall.systemPrompt).toBe(DESCENT_SYSTEM_PROMPT);
  });

  test("uses the configured inline override as the descent system prompt", async () => {
    const pages = makePages(["pa"]);
    const calls: ProviderCall[] = [];
    const provider = makeProvider({ _root: { descend: ["a"] } }, calls);

    const override = "CUSTOM DESCENT PROMPT — descend everything plausible.";
    await runTreeWalk({
      input: makeInput({ descentOverride: override }),
      tree,
      pages,
      scouts: [],
      seeds: [],
      provider,
    });

    const rootCall = calls.find((c) => nodeIdFromCall(c) === "_root")!;
    expect(rootCall.systemPrompt).toBe(override);
    expect(rootCall.systemPrompt).not.toBe(DESCENT_SYSTEM_PROMPT);
  });
});
