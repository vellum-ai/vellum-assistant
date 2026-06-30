/**
 * Tests for the `ps` route handler (GET /v1/ps).
 *
 * The handler walks the daemon's descendant process tree. We mock the
 * process-tree util so the test is deterministic and asserts the wire-shape
 * mapping (native ProcTreeNode -> ProcessEntry) rather than the real table.
 */

import { describe, expect, mock, test } from "bun:test";

import type { ProcInfo, ProcTreeNode } from "../../../util/process-tree.js";

let procsToReturn: ProcInfo[] = [];
let listShouldThrow = false;

mock.module("../../../util/process-tree.js", () => ({
  listProcesses: async () => {
    if (listShouldThrow) throw new Error("no /proc and ps unavailable");
    return procsToReturn;
  },
  buildProcessTree: (_procs: ProcInfo[], rootPid: number): ProcTreeNode => ({
    pid: rootPid,
    name: "assistant.ts",
    command: "bun run assistant.ts",
    children: [
      { pid: 200, name: "qdrant", command: "qdrant", children: [] },
      {
        pid: 300,
        name: "jobs-worker",
        command: "bun run /app/jobs/worker.ts",
        children: [
          {
            pid: 400,
            name: "embed-helper",
            command: "embed-helper",
            children: [],
          },
        ],
      },
    ],
  }),
}));

const { ROUTES } = await import("../ps-routes.js");

function getHandler() {
  const route = ROUTES.find((r) => r.operationId === "ps");
  if (!route) throw new Error("ps route not registered");
  return route.handler as () => Promise<{
    processes: Array<{
      name: string;
      status: string;
      info?: string;
      children?: unknown[];
    }>;
  }>;
}

describe("ps route handler", () => {
  test("maps the process tree to running ProcessEntry nodes", async () => {
    procsToReturn = [{ pid: process.pid, ppid: 1, command: "bun" }];
    listShouldThrow = false;

    const { processes } = await getHandler()();

    expect(processes).toHaveLength(1);
    const root = processes[0];
    expect(root.name).toBe("assistant.ts");
    expect(root.status).toBe("running");
    expect(root.info).toBe(`pid ${process.pid}`);
    expect(root.children).toHaveLength(2);
  });

  test("includes the memory worker as a descendant with its own children", async () => {
    procsToReturn = [];
    listShouldThrow = false;

    const { processes } = await getHandler()();
    const names = JSON.stringify(processes);

    expect(names).toContain("jobs-worker");
    expect(names).toContain("embed-helper");
  });

  test("every node is reported as running with a pid info field", async () => {
    procsToReturn = [];
    listShouldThrow = false;

    const { processes } = await getHandler()();
    const walk = (n: {
      status: string;
      info?: string;
      children?: unknown[];
    }): void => {
      expect(n.status).toBe("running");
      expect(n.info).toMatch(/^pid \d+$/);
      for (const c of (n.children ?? []) as Array<typeof n>) walk(c);
    };
    walk(processes[0]);
  });

  test("falls back to a lone assistant node when enumeration fails", async () => {
    listShouldThrow = true;

    const { processes } = await getHandler()();

    expect(processes).toHaveLength(1);
    expect(processes[0]).toEqual({
      name: "assistant",
      status: "running",
      info: `pid ${process.pid}`,
    });
  });
});
