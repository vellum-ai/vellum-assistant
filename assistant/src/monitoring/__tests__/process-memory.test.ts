import { describe, expect, test } from "bun:test";

import {
  effectiveSizeBytes,
  parseSmapsRollup,
  topProcessesByMemory,
} from "../process-memory.js";

const SMAPS_ROLLUP = `555c98516000-7ffe248ca000 ---p 00000000 00:00 0                          [rollup]
Rss:              524288 kB
Pss:              262144 kB
Pss_Dirty:        131072 kB
Pss_Anon:         196608 kB
Pss_File:          61440 kB
Pss_Shmem:          4096 kB
Shared_Clean:     262144 kB
Private_Dirty:    131072 kB
Anonymous:        196608 kB
Swap:                  0 kB
`;

describe("parseSmapsRollup", () => {
  test("extracts PSS, RSS, and the anon/file/shmem split in bytes", () => {
    expect(parseSmapsRollup(SMAPS_ROLLUP)).toEqual({
      rssBytes: 524288 * 1024,
      pssBytes: 262144 * 1024,
      pssAnonBytes: 196608 * 1024,
      pssFileBytes: 61440 * 1024,
      pssShmemBytes: 4096 * 1024,
    });
  });

  test("reports null for fields the kernel does not expose", () => {
    // Pre-5.4 kernels lack the Pss_Anon/Pss_File/Pss_Shmem split.
    const mem = parseSmapsRollup("Rss:  100 kB\nPss:  60 kB\n");
    expect(mem).toEqual({
      rssBytes: 100 * 1024,
      pssBytes: 60 * 1024,
      pssAnonBytes: null,
      pssFileBytes: null,
      pssShmemBytes: null,
    });
  });

  test("tolerates the header line and empty input", () => {
    expect(parseSmapsRollup("").rssBytes).toBeNull();
    expect(
      parseSmapsRollup("00400000-7fff0000 ---p 00000000 00:00 0 [rollup]\n")
        .pssBytes,
    ).toBeNull();
  });
});

describe("effectiveSizeBytes", () => {
  test("prefers PSS, falls back to RSS, then zero", () => {
    const base = {
      pssAnonBytes: null,
      pssFileBytes: null,
      pssShmemBytes: null,
    };
    expect(effectiveSizeBytes({ ...base, rssBytes: 100, pssBytes: 60 })).toBe(
      60,
    );
    expect(effectiveSizeBytes({ ...base, rssBytes: 100, pssBytes: null })).toBe(
      100,
    );
    expect(
      effectiveSizeBytes({ ...base, rssBytes: null, pssBytes: null }),
    ).toBe(0);
  });
});

describe("topProcessesByMemory", () => {
  test("uses Win32 working-set data on Windows", () => {
    const result = topProcessesByMemory(1, {
      platform: "win32",
      processTable: [
        { pid: 10, ppid: 4, command: "helper.exe", rssBytes: 1024 },
        {
          pid: 11,
          ppid: 4,
          command: '"C:\\Program Files\\Bun\\bun.exe" worker.ts',
          rssBytes: 4096,
        },
      ],
    });

    expect(result).toEqual([
      {
        pid: 11,
        command: "worker",
        rssBytes: 4096,
        pssBytes: null,
        pssAnonBytes: null,
        pssFileBytes: null,
        pssShmemBytes: null,
      },
    ]);
  });
});
