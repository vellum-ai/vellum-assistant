/**
 * Tests for what `assistant roadmap` sends to the daemon and what it prints
 * back. The flags a caller types are the whole interface here: the daemon
 * route sees only what this layer forwards, so the params, the repeatable
 * `--tag`, and the rendered output are the things worth pinning.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

interface IpcCall {
  operationId: string;
  params?: Record<string, unknown>;
}

let calls: IpcCall[] = [];
let nextResult: unknown = {};

// Spread the real module: replacing it wholesale strips the other exports
// that the CLI program's own imports rely on.
const actualCliClient = await import("../../ipc/cli-client.js");
mock.module("../../ipc/cli-client.js", () => ({
  ...actualCliClient,
  cliIpcCall: async (operationId: string, params?: Record<string, unknown>) => {
    calls.push({ operationId, params });
    return { ok: true, result: nextResult };
  },
  exitFromIpcResult: (r: { error?: string }) => {
    throw new Error(r.error ?? "ipc failure");
  },
}));

const { runAssistantCommandFull } = await import("./run-assistant-command.js");

const ITEM = {
  slug: "dark-mode",
  title: "Add dark mode",
  status: "open",
  url: "https://www.vellum.ai/roadmap/dark-mode",
  upvoteCount: 12,
  commentCount: 1,
  tags: [{ slug: "ui", name: "UI" }],
  viewerUpvoted: true,
};

beforeEach(() => {
  calls = [];
  nextResult = {};
});

describe("roadmap list", () => {
  test("forwards every filter as a query param", async () => {
    nextResult = { items: [], total: 0 };

    await runAssistantCommandFull(
      "roadmap",
      "list",
      "--query",
      "dark",
      "--status",
      "planned",
      "--tag",
      "ui",
      "--sort",
      "upvotes",
      "--limit",
      "5",
      "--offset",
      "10",
    );

    expect(calls).toEqual([
      {
        operationId: "roadmap_list",
        params: {
          queryParams: {
            q: "dark",
            status: "planned",
            tag: "ui",
            sort: "upvotes",
            limit: "5",
            offset: "10",
          },
        },
      },
    ]);
  });

  test("renders each item with its counts, tags and link", async () => {
    nextResult = { items: [ITEM], total: 30 };

    const { stdout } = await runAssistantCommandFull("roadmap", "list");

    expect(stdout).toContain("Showing 1 of 30 items:");
    expect(stdout).toContain("Add dark mode");
    expect(stdout).toContain("▲12 (upvoted)");
    expect(stdout).toContain("[ui]");
    expect(stdout).toContain("https://www.vellum.ai/roadmap/dark-mode");
  });

  test("strips terminal control sequences out of public text", async () => {
    nextResult = {
      items: [{ ...ITEM, title: "Add \x1b[31mdark\x1b[0m mode" }],
      total: 1,
    };

    const { stdout } = await runAssistantCommandFull("roadmap", "list");

    expect(stdout).toContain("Add dark mode");
    expect(stdout).not.toContain("\x1b[31m");
  });

  test("--json emits the route payload verbatim", async () => {
    nextResult = { items: [ITEM], total: 30 };

    const { stdout } = await runAssistantCommandFull(
      "roadmap",
      "list",
      "--json",
    );

    expect(JSON.parse(stdout)).toEqual({ items: [ITEM], total: 30 });
  });
});

describe("roadmap get", () => {
  test("marks assistant and staff comment authors", async () => {
    nextResult = {
      ...ITEM,
      description: "Follow the OS setting",
      creatorUsername: "aria",
      creatorKind: "assistant",
      created: "2026-09-01",
      comments: [
        {
          id: "c1",
          authorUsername: "aria",
          authorKind: "assistant",
          authorIsStaff: false,
          body: "Filed this",
          created: "2026-09-01",
        },
        {
          id: "c2",
          authorUsername: "sam",
          authorKind: null,
          authorIsStaff: true,
          body: "Planned",
          created: "2026-09-02",
        },
      ],
    };

    const { stdout } = await runAssistantCommandFull(
      "roadmap",
      "get",
      "dark-mode",
    );

    expect(calls[0]).toEqual({
      operationId: "roadmap_get",
      params: { pathParams: { slug: "dark-mode" } },
    });
    expect(stdout).toContain("by:       aria (assistant)");
    expect(stdout).toContain("aria [assistant]");
    expect(stdout).toContain("sam [staff]");
    expect(stdout).toContain("Follow the OS setting");
  });

  test("keeps the line breaks in a multi-line comment while stripping escapes", async () => {
    nextResult = {
      ...ITEM,
      description: "",
      creatorUsername: "aria",
      creatorKind: null,
      created: "2026-09-01",
      comments: [
        {
          id: "c1",
          authorUsername: "sam",
          authorKind: null,
          authorIsStaff: false,
          body: "First line\n\x1b[2JSecond line",
          created: "2026-09-02",
        },
      ],
    };

    const { stdout } = await runAssistantCommandFull(
      "roadmap",
      "get",
      "dark-mode",
    );

    expect(stdout).toContain("    First line\n    Second line\n");
  });
});

describe("roadmap writes", () => {
  test("create accumulates a repeated --tag", async () => {
    nextResult = ITEM;

    await runAssistantCommandFull(
      "roadmap",
      "create",
      "--title",
      "Add dark mode",
      "--tag",
      "ui",
      "--tag",
      "theming",
    );

    expect(calls[0].params).toEqual({
      body: {
        title: "Add dark mode",
        description: undefined,
        tags: ["ui", "theming"],
      },
    });
  });

  test("update sends only the fields that were passed", async () => {
    nextResult = ITEM;

    await runAssistantCommandFull(
      "roadmap",
      "update",
      "dark-mode",
      "--status",
      "planned",
    );

    expect(calls[0]).toEqual({
      operationId: "roadmap_update",
      params: {
        pathParams: { slug: "dark-mode" },
        body: {
          title: undefined,
          description: undefined,
          status: "planned",
          tags: undefined,
        },
      },
    });
  });

  test("--clear-tags sends the empty set that --tag cannot express", async () => {
    nextResult = ITEM;

    await runAssistantCommandFull(
      "roadmap",
      "update",
      "dark-mode",
      "--clear-tags",
    );

    expect((calls[0].params as { body: { tags: string[] } }).body.tags).toEqual(
      [],
    );
  });

  test("--clear-tags with --tag is refused rather than silently picking one", async () => {
    nextResult = ITEM;
    process.exitCode = 0;

    // The complaint itself goes straight to stderr, which this harness does
    // not capture; what matters is that no update was forwarded.
    await runAssistantCommandFull(
      "roadmap",
      "update",
      "dark-mode",
      "--clear-tags",
      "--tag",
      "ui",
    );

    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  test("delete names the item it removed", async () => {
    nextResult = { slug: "dark-mode", deleted: true };

    const { stdout } = await runAssistantCommandFull(
      "roadmap",
      "delete",
      "dark-mode",
    );

    expect(calls[0].operationId).toBe("roadmap_delete");
    expect(stdout).toContain("Deleted roadmap item: dark-mode");
  });

  test("upvote and unvote hit their own operations and report the count", async () => {
    nextResult = { slug: "dark-mode", upvoteCount: 13 };
    const up = await runAssistantCommandFull("roadmap", "upvote", "dark-mode");

    nextResult = { slug: "dark-mode", upvoteCount: 12 };
    const down = await runAssistantCommandFull(
      "roadmap",
      "unvote",
      "dark-mode",
    );

    expect(calls.map((c) => c.operationId)).toEqual([
      "roadmap_upvote",
      "roadmap_unvote",
    ]);
    expect(up.stdout).toContain("Upvoted: dark-mode (13 total)");
    expect(down.stdout).toContain("Removed upvote: dark-mode (12 total)");
  });
});
