/**
 * Tests for the v3 page→leaf classifier. Uses a stub provider so no live LLM
 * is hit. Pages are written into a temp workspace.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolUseContent,
} from "../../../providers/types.js";
import { readPage, writePage } from "../../v2/page-store.js";
import type { ConceptPageFrontmatter } from "../../v2/types.js";
import type { LeafNode, LeafTree } from "../types.js";

// Stub the provider layer before importing `assign.js` so its static import
// chain (which transitively pulls in CES/credential workspace packages that
// aren't built in a fresh worktree) never loads. The classifier is
// provider-injectable, so every test passes its own stub provider — the real
// `getConfiguredProvider` is never exercised here.
mock.module("../../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => null,
  extractToolUse: (response: ProviderResponse) =>
    response.content.find((b): b is ToolUseContent => b.type === "tool_use"),
  userMessage: (text: string): Message => ({
    role: "user",
    content: [{ type: "text", text }],
  }),
}));

const { assignPages } = await import("../assign.js");

function makeLeaf(path: string, description: string): LeafNode {
  return {
    path,
    frontmatter: { path, in_core: false },
    description,
    members: [],
    domain: path.split("/")[0],
  };
}

function makeTree(leaves: LeafNode[]): LeafTree {
  return {
    leaves: new Map(leaves.map((l) => [l.path, l])),
    byPage: new Map(),
  };
}

/** Sorted by path: [1] domain-a/topic-x, [2] domain-a/topic-y, [3] domain-b/topic-z */
function threeLeafTree(): LeafTree {
  return makeTree([
    makeLeaf("domain-b/topic-z", "about z"),
    makeLeaf("domain-a/topic-x", "about x"),
    makeLeaf("domain-a/topic-y", "about y"),
  ]);
}

function stubProvider(
  handler: (
    messages: Message[],
    options?: SendMessageOptions,
  ) => ProviderResponse | Promise<ProviderResponse>,
): Provider {
  return {
    name: "stub",
    sendMessage: async (messages, options) => handler(messages, options),
  } as Provider;
}

function response(content: ProviderResponse["content"]): ProviderResponse {
  return {
    content,
    model: "stub-model",
    stopReason: "tool_use",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function toolResponse(ids: unknown[]): ProviderResponse {
  return response([
    { type: "tool_use", id: "tu-1", name: "assign_leaves", input: { ids } },
  ]);
}

function textResponse(text: string): ProviderResponse {
  return response([{ type: "text", text }]);
}

let workspaceDir: string;

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "v3-assign-"));
});

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

async function makePage(
  slug: string,
  frontmatter: Partial<ConceptPageFrontmatter>,
  body = "page body",
): Promise<void> {
  await writePage(workspaceDir, {
    slug,
    frontmatter: { edges: [], ref_files: [], ref_urls: [], ...frontmatter },
    body,
  });
}

describe("assignPages", () => {
  test("unions classified picks with prior picks, never overwriting", async () => {
    await makePage("page-a", { leaves: ["domain-a/topic-x"] });
    // Classifier returns [2] -> domain-a/topic-y and [1] -> already present.
    const provider = stubProvider(() => toolResponse([2, 1]));

    const results = await assignPages({
      tree: threeLeafTree(),
      workspaceDir,
      slugs: ["page-a"],
      provider,
      throttleMs: 0,
    });

    expect(results).toEqual([
      {
        slug: "page-a",
        before: ["domain-a/topic-x"],
        after: ["domain-a/topic-x", "domain-a/topic-y"],
        failed: false,
      },
    ]);

    const written = await readPage(workspaceDir, "page-a");
    expect(written?.frontmatter.leaves).toEqual([
      "domain-a/topic-x",
      "domain-a/topic-y",
    ]);
  });

  test("classification failure leaves the page's leaves unchanged", async () => {
    await makePage("page-a", { leaves: ["domain-b/topic-z"] });

    // (a) provider throws
    const throwing = stubProvider(() => {
      throw new Error("boom");
    });
    let results = await assignPages({
      tree: threeLeafTree(),
      workspaceDir,
      slugs: ["page-a"],
      provider: throwing,
      throttleMs: 0,
    });
    expect(results[0]).toEqual({
      slug: "page-a",
      before: ["domain-b/topic-z"],
      after: ["domain-b/topic-z"],
      failed: true,
    });
    expect(
      (await readPage(workspaceDir, "page-a"))?.frontmatter.leaves,
    ).toEqual(["domain-b/topic-z"]);

    // (b) no tool use
    results = await assignPages({
      tree: threeLeafTree(),
      workspaceDir,
      slugs: ["page-a"],
      provider: stubProvider(() => textResponse("no tool here")),
      throttleMs: 0,
    });
    expect(results[0].failed).toBe(true);
    expect(
      (await readPage(workspaceDir, "page-a"))?.frontmatter.leaves,
    ).toEqual(["domain-b/topic-z"]);

    // (c) empty ids
    results = await assignPages({
      tree: threeLeafTree(),
      workspaceDir,
      slugs: ["page-a"],
      provider: stubProvider(() => toolResponse([])),
      throttleMs: 0,
    });
    expect(results[0].failed).toBe(true);
    expect(
      (await readPage(workspaceDir, "page-a"))?.frontmatter.leaves,
    ).toEqual(["domain-b/topic-z"]);
  });

  test("deterministic id->path mapping, dropping out-of-range and 0 ids", async () => {
    await makePage("page-a", {});
    // 0 and 99 are invalid; 3 -> domain-b/topic-z; 1 -> domain-a/topic-x.
    const provider = stubProvider(() => toolResponse([0, 99, 3, 1, -1, 2.5]));

    const results = await assignPages({
      tree: threeLeafTree(),
      workspaceDir,
      slugs: ["page-a"],
      provider,
      throttleMs: 0,
    });

    expect(results[0].after).toEqual(["domain-b/topic-z", "domain-a/topic-x"]);
    expect(results[0].failed).toBe(false);
  });

  test("defaults to pages with empty or missing leaves", async () => {
    await makePage("page-empty", { leaves: [] });
    await makePage("page-missing", {});
    await makePage("page-classified", { leaves: ["domain-a/topic-x"] });

    const seen: string[] = [];
    const provider = stubProvider((messages) => {
      const text = messages[0]?.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      seen.push(text);
      return toolResponse([2]);
    });

    const results = await assignPages({
      tree: threeLeafTree(),
      workspaceDir,
      provider,
      throttleMs: 0,
    });

    const slugs = results.map((r) => r.slug).sort();
    expect(slugs).toEqual(["page-empty", "page-missing"]);
    // The classified page was never sent to the provider.
    expect(seen.length).toBe(2);
  });
});
