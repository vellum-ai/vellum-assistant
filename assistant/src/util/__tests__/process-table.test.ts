import { describe, expect, test } from "bun:test";

import {
  parsePsProcessTable,
  parseWindowsProcessTable,
} from "../process-table.js";

describe("parsePsProcessTable", () => {
  test("preserves command lines while parsing process relationships", () => {
    expect(
      parsePsProcessTable(
        "  10     1 /usr/bin/bun run worker.ts arg\n  11    10 helper\n",
      ),
    ).toEqual([
      { pid: 10, ppid: 1, command: "/usr/bin/bun run worker.ts arg" },
      { pid: 11, ppid: 10, command: "helper" },
    ]);
  });
});

describe("parseWindowsProcessTable", () => {
  test("parses PowerShell JSON and falls back to the image name", () => {
    expect(
      parseWindowsProcessTable(
        JSON.stringify([
          {
            ProcessId: 100,
            ParentProcessId: 4,
            CommandLine: "C:\\Program Files\\Bun\\bun.exe worker.ts",
            Name: "bun.exe",
            WorkingSetSize: 4096,
            HandleCount: 42,
          },
          {
            ProcessId: 101,
            ParentProcessId: 100,
            CommandLine: null,
            Name: "helper.exe",
          },
        ]),
      ),
    ).toEqual([
      {
        pid: 100,
        ppid: 4,
        command: "C:\\Program Files\\Bun\\bun.exe worker.ts",
        rssBytes: 4096,
        handleCount: 42,
      },
      { pid: 101, ppid: 100, command: "helper.exe" },
    ]);
  });

  test("handles the single-object shape emitted for one process", () => {
    expect(
      parseWindowsProcessTable(
        JSON.stringify({
          ProcessId: 100,
          ParentProcessId: 4,
          CommandLine: "worker.exe",
          Name: "worker.exe",
        }),
      ),
    ).toEqual([{ pid: 100, ppid: 4, command: "worker.exe" }]);
  });
});
