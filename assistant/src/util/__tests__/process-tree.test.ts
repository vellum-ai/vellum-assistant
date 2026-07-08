/**
 * Tests for the native process-tree helpers.
 *
 * `buildProcessTree` and `deriveName` are pure, so they're tested directly
 * with synthetic `(pid, ppid, command)` rows — no real process table needed.
 */

import { describe, expect, test } from "bun:test";

import {
  buildProcessTree,
  deriveName,
  type ProcInfo,
} from "../process-tree.js";

describe("deriveName", () => {
  test("uses the executable basename for plain commands", () => {
    expect(deriveName("/usr/local/bin/qdrant --config foo")).toBe("qdrant");
    expect(deriveName("qdrant")).toBe("qdrant");
  });

  test("summarizes the script path as <parent>-<file> for interpreter invocations", () => {
    expect(deriveName("bun run /home/u/app/jobs/worker.ts")).toBe(
      "jobs-worker",
    );
    expect(deriveName("bun run /home/u/app/daemon/main.ts")).toBe(
      "daemon-main",
    );
    expect(deriveName("bun --smol /opt/embed/embed-worker.ts model dir")).toBe(
      "embed-embed-worker",
    );
    expect(deriveName("node /srv/http/index.js --port 3000")).toBe(
      "http-index",
    );
    expect(deriveName("python3 /x/y/server.py")).toBe("y-server");
  });

  test("falls back to the bare filename for a script at the filesystem root", () => {
    expect(deriveName("bun run /worker.ts")).toBe("worker");
  });

  test("surfaces the arguments when an interpreter runs no script file", () => {
    expect(deriveName("bun repl")).toBe("bun repl");
    expect(deriveName("bun run dev")).toBe("bun run dev");
    expect(deriveName("bun x prettier --write .")).toBe("bun x prettier .");
    expect(deriveName("node --inspect server")).toBe("node server");
  });

  test("falls back to the bare interpreter when only flags follow", () => {
    expect(deriveName("bun --version")).toBe("bun");
    expect(deriveName("bun")).toBe("bun");
  });

  test("handles empty input", () => {
    expect(deriveName("")).toBe("(unknown)");
    expect(deriveName("   ")).toBe("(unknown)");
  });
});

describe("buildProcessTree", () => {
  const procs: ProcInfo[] = [
    { pid: 100, ppid: 1, command: "bun run /app/daemon/main.ts" },
    { pid: 200, ppid: 100, command: "/usr/bin/qdrant" },
    { pid: 300, ppid: 100, command: "bun run /app/jobs/worker.ts" },
    { pid: 400, ppid: 300, command: "/usr/bin/embed-helper" },
    { pid: 999, ppid: 1, command: "unrelated" },
  ];

  test("builds the subtree rooted at the daemon PID", () => {
    const tree = buildProcessTree(procs, 100);

    expect(tree.pid).toBe(100);
    expect(tree.name).toBe("daemon-main");
    expect(tree.children.map((c) => c.pid)).toEqual([200, 300]);
  });

  test("recurses into grandchildren", () => {
    const tree = buildProcessTree(procs, 100);
    const worker = tree.children.find((c) => c.pid === 300)!;

    expect(worker.name).toBe("jobs-worker");
    expect(worker.children.map((c) => c.pid)).toEqual([400]);
    expect(worker.children[0].name).toBe("embed-helper");
  });

  test("excludes processes not descended from the root", () => {
    const tree = buildProcessTree(procs, 100);
    const allPids = (n: typeof tree): number[] => [
      n.pid,
      ...n.children.flatMap(allPids),
    ];
    expect(allPids(tree)).not.toContain(999);
  });

  test("orders children by PID", () => {
    const shuffled: ProcInfo[] = [
      { pid: 1, ppid: 0, command: "root" },
      { pid: 30, ppid: 1, command: "c" },
      { pid: 10, ppid: 1, command: "a" },
      { pid: 20, ppid: 1, command: "b" },
    ];
    const tree = buildProcessTree(shuffled, 1);
    expect(tree.children.map((c) => c.pid)).toEqual([10, 20, 30]);
  });

  test("synthesizes an 'assistant' node when the root PID is absent", () => {
    const tree = buildProcessTree(procs, 55555);
    expect(tree.pid).toBe(55555);
    expect(tree.name).toBe("assistant");
    expect(tree.children).toEqual([]);
  });

  test("does not loop on a self-parented process", () => {
    const cyclic: ProcInfo[] = [{ pid: 7, ppid: 7, command: "weird" }];
    const tree = buildProcessTree(cyclic, 7);
    expect(tree.pid).toBe(7);
    expect(tree.children).toEqual([]);
  });

  test("does not loop on a parent/child cycle", () => {
    const cyclic: ProcInfo[] = [
      { pid: 1, ppid: 2, command: "a" },
      { pid: 2, ppid: 1, command: "b" },
    ];
    const tree = buildProcessTree(cyclic, 1);
    // 1 -> 2 -> (1 already visited, stop)
    expect(tree.pid).toBe(1);
    expect(tree.children.map((c) => c.pid)).toEqual([2]);
    expect(tree.children[0].children).toEqual([]);
  });
});
