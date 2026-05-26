/**
 * Tests for `assistant/src/memory/v3/tree-walk.ts`.
 *
 * The descent provider is always a scripted stub injected via the `provider`
 * arg — no real LLM, no network, no `mock.module`, `~/.vellum/` untouched. The
 * stub keys its scripted decision off the `<node id="...">` marker in the user
 * message so one fixture provider can drive a whole multi-node walk.
 *
 * Coverage:
 *   - scripted descent collects the kept leaf pages and records
 *     considered/descended/skipped + reasoning per node.
 *   - one descent call per *visited node with children* (node or page) — leaf
 *     buckets are now judged for page selection, not bulk-collected.
 *   - the descender keeps only the pages the model selects (drops the rest).
 *   - breadthBudget caps descents per node; maxDepth halts the walk.
 *   - the walk starts at root only — scout hits steer it as prompt pressure,
 *     not as mid-tree seeds.
 *   - provider === null → fail-safe: descend + keep nothing, walk still
 *     terminates, reasoning records the failure.
 *   - the forced tool exposes keep_pages (enum = offered page slugs).
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
import type { LlmCallRecord } from "../llm-capture.js";
import { DESCENT_SYSTEM_PROMPT } from "../prompts/system-prompts.js";
import type { ChildRef, TreeIndex } from "../tree-index.js";
import { createDescender, runTreeWalk } from "../tree-walk.js";
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
 * `nodes`, `childrenByNode`, and the `pageParents` reverse edges. `parentsByNode`
 * is left empty — the driver never reads it.
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

/** Read the `keep_pages` enum (offered page slugs) out of a built descend tool. */
function keepPagesEnum(tool: ToolDefinition | undefined): string[] {
  const schema = tool?.input_schema as
    | { properties?: { keep_pages?: { items?: { enum?: string[] } } } }
    | undefined;
  return schema?.properties?.keep_pages?.items?.enum ?? [];
}

/**
 * A scripted descent provider. `script` maps a node id to the bare child-node
 * ids to descend, an optional explicit `keep` (page slugs), and an optional
 * reasoning. When `keep` is omitted the stub keeps *every* offered page (the old
 * bulk behavior), so a test only sets `keep` when exercising selective keeping.
 * Records every call and honors an already-aborted signal by throwing.
 */
function makeProvider(
  script: Record<
    string,
    { descend: string[]; keep?: string[]; reasoning?: string }
  >,
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
      const keep = decision.keep ?? keepPagesEnum(tools?.[0]);
      const input: Record<string, unknown> = {
        descend: decision.descend,
        keep_pages: keep,
      };
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
// runTreeWalk — scripted descent
// ---------------------------------------------------------------------------

describe("runTreeWalk — scripted descent", () => {
  test("collects the kept leaf pages and records the descend/skip split", async () => {
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
      provider,
    });

    // Only the descended branch's page is kept; b is skipped entirely.
    expect([...collected]).toEqual(["pa"]);

    const rootLevel = levels.find((l) => l.node === "_root")!;
    expect(rootLevel.considered).toEqual(["a", "b"]);
    expect(rootLevel.descended).toEqual(["a"]);
    expect(rootLevel.skipped).toEqual(["b"]);
    expect(rootLevel.reasoning).toBe("a matches the turn");

    // _root (node children) and a (page child) are both walked; b is skipped.
    expect(levels.map((l) => l.node).sort()).toEqual(["_root", "a"]);
  });

  test("omitted keep_pages keeps every offered page at the node (recall-safe)", async () => {
    // _root → a, a leaf bucket of two pages. The model descends but returns NO
    // keep_pages field at all — a silent omission must keep every offered page,
    // not drop them all.
    const tree = makeTree("_root", {
      _root: [node("a")],
      a: [page("frames/example-a"), page("people/alice")],
    });
    const pages = makePages(["frames/example-a", "people/alice"]);
    const calls: ProviderCall[] = [];
    // Bespoke stub: emits tool input WITHOUT a `keep_pages` key for node "a".
    const provider: Provider = {
      name: "omit-keep-pages",
      sendMessage: async (messages, tools, systemPrompt, options) => {
        calls.push({ messages, tools, systemPrompt, options });
        const nodeId =
          nodeIdFromCall({ messages, tools, systemPrompt, options }) ?? "";
        const input: Record<string, unknown> =
          nodeId === "_root"
            ? { descend: ["a"], keep_pages: [] }
            : { descend: [] }; // node "a": keep_pages omitted entirely
        return {
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
      },
    };

    const { pages: collected } = await runTreeWalk({
      input: makeInput(),
      tree,
      pages,
      scouts: [],
      provider,
    });

    // Both offered pages survive the omission.
    expect([...collected].sort()).toEqual(["frames/example-a", "people/alice"]);
  });

  test("explicit empty keep_pages keeps no pages at the node", async () => {
    // Same tree, but node "a" returns an *explicit* empty keep_pages — honored
    // as the model genuinely keeping nothing here.
    const tree = makeTree("_root", {
      _root: [node("a")],
      a: [page("frames/example-a"), page("people/alice")],
    });
    const pages = makePages(["frames/example-a", "people/alice"]);
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      {
        _root: { descend: ["a"], keep: [] },
        a: { descend: [], keep: [] },
      },
      calls,
    );

    const { pages: collected } = await runTreeWalk({
      input: makeInput(),
      tree,
      pages,
      scouts: [],
      provider,
    });

    expect([...collected]).toEqual([]);
  });

  test("keeps only the pages the model selects at a node", async () => {
    // _root → a, a leaf bucket of two pages. The model keeps only one.
    const tree = makeTree("_root", {
      _root: [node("a")],
      a: [page("pa-keep"), page("pa-drop")],
    });
    const pages = makePages(["pa-keep", "pa-drop"]);
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      {
        _root: { descend: ["a"] },
        a: { descend: [], keep: ["pa-keep"] },
      },
      calls,
    );

    const { pages: collected } = await runTreeWalk({
      input: makeInput(),
      tree,
      pages,
      scouts: [],
      provider,
    });

    expect([...collected]).toEqual(["pa-keep"]);
  });

  test("makes one descent call per visited node with children", async () => {
    const tree = makeTree("_root", {
      _root: [node("a"), node("b")],
      a: [node("c"), page("pa")],
      b: [page("pb")],
      c: [page("pc")],
    });
    const pages = makePages(["pa", "pb", "pc"]);
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      { _root: { descend: ["a", "b"] }, a: { descend: ["c"] } },
      calls,
    );

    await runTreeWalk({
      input: makeInput(),
      tree,
      pages,
      scouts: [],
      provider,
    });

    // Every visited node has children (b and c are page-only leaf buckets that
    // now get a page-selection call too), so all four are called.
    const calledNodes = calls.map(nodeIdFromCall).sort();
    expect(calledNodes).toEqual(["_root", "a", "b", "c"]);
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
      provider,
    });

    // Depth 0 (_root) and depth 1 (a) walked; b never reached.
    expect(levels.map((l) => l.node)).toEqual(["_root", "a"]);
    expect([...collected]).toEqual(["pa"]);
  });
});

// ---------------------------------------------------------------------------
// runTreeWalk — root-only walk + scout pressure
// ---------------------------------------------------------------------------

describe("runTreeWalk — root-only walk", () => {
  test("starts at root only — a scout hit in an unreachable subtree is not walked", async () => {
    // root only links to `a`; `island` is unreachable from root. A scout
    // surfaced its leaf page, but the walk no longer seeds at scout parents.
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
      provider,
    });

    // Only the root branch is walked; `island`/treasure is never reached.
    expect([...collected]).toEqual(["pa"]);
    expect(levels.map((l) => l.node).sort()).toEqual(["_root", "a"]);
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
      scouts,
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
// runTreeWalk — fail-safe
// ---------------------------------------------------------------------------

describe("runTreeWalk — fail-safe", () => {
  test("provider null descends and keeps nothing but still terminates", async () => {
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
      provider: null,
    });

    // No provider → the node keeps nothing (the scout lanes carry recall in the
    // loop), descends nothing, and the walk stops at root.
    expect([...collected]).toEqual([]);
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
      provider,
    });

    const rootLevel = levels.find((l) => l.node === "_root")!;
    expect(rootLevel.descended).toEqual([]);
    expect(rootLevel.reasoning).toContain("validation");
  });
});

// ---------------------------------------------------------------------------
// createDescender — request shape + page selection
// ---------------------------------------------------------------------------

describe("createDescender — request shape", () => {
  test("forces tool_choice on choose_branches and forwards the abort signal", async () => {
    const tree = makeTree("_root", {
      _root: [node("a")],
      a: [page("pa")],
    });
    const pages = makePages(["pa"]);
    const calls: ProviderCall[] = [];
    const provider = makeProvider({ _root: { descend: ["a"] } }, calls);

    const descender = createDescender({
      input: makeInput({ signal: AbortSignal.timeout(10_000) }),
      tree,
      pages,
      scouts: [],
      provider,
    });

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

  test("exposes a keep_pages enum of the node's offered page slugs", async () => {
    const tree = makeTree("bucket", {
      bucket: [page("p1"), page("p2")],
    });
    const pages = makePages(["p1", "p2"]);
    const calls: ProviderCall[] = [];
    const provider = makeProvider({}, calls);

    const descender = createDescender({
      input: makeInput(),
      tree,
      pages,
      scouts: [],
      provider,
    });

    await descender("bucket", [...tree.childrenByNode.get("bucket")!]);

    expect(keepPagesEnum(calls[0].tools?.[0]).sort()).toEqual(["p1", "p2"]);
  });

  test("a node with no children at all makes no provider call", async () => {
    const tree = makeTree("empty", { empty: [] });
    const pages = makePages([]);
    const calls: ProviderCall[] = [];
    const provider = makeProvider({}, calls);

    const descender = createDescender({
      input: makeInput(),
      tree,
      pages,
      scouts: [],
      provider,
    });

    const result = await descender("empty", [
      ...(tree.childrenByNode.get("empty") ?? []),
    ]);
    expect(result).toEqual({ descend: [], keep: [], reasoning: "" });
    expect(calls).toHaveLength(0);
  });

  test("a leaf bucket of pages makes a call and keeps the selected pages", async () => {
    const tree = makeTree("leaf", { leaf: [page("p1"), page("p2")] });
    const pages = makePages(["p1", "p2"]);
    const calls: ProviderCall[] = [];
    // Keep only p1.
    const provider = makeProvider(
      { leaf: { descend: [], keep: ["p1"] } },
      calls,
    );

    const descender = createDescender({
      input: makeInput(),
      tree,
      pages,
      scouts: [],
      provider,
    });

    const result = await descender("leaf", [
      ...tree.childrenByNode.get("leaf")!,
    ]);

    expect(calls).toHaveLength(1);
    expect(result.descend).toEqual([]);
    expect(result.keep).toEqual([page("p1")]);
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
      provider,
    });

    const rootCall = calls.find((c) => nodeIdFromCall(c) === "_root")!;
    expect(rootCall.systemPrompt).toBe(override);
    expect(rootCall.systemPrompt).not.toBe(DESCENT_SYSTEM_PROMPT);
  });
});

describe("runTreeWalk — capture", () => {
  test("emits one record per descender LLM call, tagged with the node", async () => {
    // _root has node children but descends nothing, so exactly one call fires.
    const tree = makeTree("_root", {
      _root: [node("a"), node("b")],
      a: [page("pa")],
      b: [page("pb")],
    });
    const pages = makePages(["pa", "pb"]);
    const calls: ProviderCall[] = [];
    const provider = makeProvider({ _root: { descend: [] } }, calls);
    const captured: Omit<LlmCallRecord, "pass">[] = [];

    await runTreeWalk({
      input: makeInput(),
      tree,
      pages,
      scouts: [],
      provider,
      capture: (record) => captured.push(record),
    });

    expect(captured).toHaveLength(1);
    const rec = captured[0]!;
    expect(rec.lane).toBe("descent");
    expect(rec.callSite).toBe("memoryV3Descent");
    expect(rec.node).toBe("_root");
    expect(rec.request.tools[0]!.name).toBe("choose_branches");
    expect(rec.response.stopReason).toBe("tool_use");
  });
});
