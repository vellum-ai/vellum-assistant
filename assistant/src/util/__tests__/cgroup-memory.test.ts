/**
 * Tests for the pure cgroup v2 memory.stat parser. The file-reading wrappers in
 * cgroup-memory.ts read fixed /sys/fs/cgroup paths, so only the parsing layer
 * is exercised here.
 */

import { describe, expect, test } from "bun:test";

import { parseMemoryStat } from "../cgroup-memory.js";

const FULL_MEMORY_STAT = `anon 2147483648
file 1610612736
kernel 943718400
kernel_stack 5242880
pagetables 31457280
percpu 1048576
sock 4096
vmalloc 0
shmem 8192
zswap 0
zswapped 0
file_mapped 209715200
file_dirty 135168
file_writeback 0
slab_reclaimable 838860800
slab_unreclaimable 104857600
slab 943718400
workingset_refault_anon 0
workingset_refault_file 123456
pgscan_direct 7000000
pgsteal_direct 6500000
`;

describe("parseMemoryStat", () => {
  test("extracts the recorded fields and derives the split", () => {
    const stat = parseMemoryStat(FULL_MEMORY_STAT);

    expect(stat).toEqual({
      anonBytes: 2147483648,
      fileBytes: 1610612736,
      kernelBytes: 943718400,
      slabReclaimableBytes: 838860800,
      slabUnreclaimableBytes: 104857600,
      // anon + slab_unreclaimable
      unevictableBytes: 2147483648 + 104857600,
      // file + slab_reclaimable
      reclaimableBytes: 1610612736 + 838860800,
    });
  });

  test("reports null for fields the kernel does not expose", () => {
    // Older kernels lack the aggregate `kernel` counter.
    const stat = parseMemoryStat(
      "anon 100\nfile 200\nslab_reclaimable 30\nslab_unreclaimable 40\n",
    );

    expect(stat.kernelBytes).toBeNull();
    expect(stat.unevictableBytes).toBe(140);
    expect(stat.reclaimableBytes).toBe(230);
  });

  test("derived split is null when a component is missing", () => {
    const stat = parseMemoryStat("anon 100\nfile 200\n");

    expect(stat.anonBytes).toBe(100);
    expect(stat.fileBytes).toBe(200);
    expect(stat.unevictableBytes).toBeNull();
    expect(stat.reclaimableBytes).toBeNull();
  });

  test("tolerates malformed lines and empty input", () => {
    expect(parseMemoryStat("")).toEqual({
      anonBytes: null,
      fileBytes: null,
      kernelBytes: null,
      slabReclaimableBytes: null,
      slabUnreclaimableBytes: null,
      unevictableBytes: null,
      reclaimableBytes: null,
    });

    const stat = parseMemoryStat("anon notanumber\nfile 200\ngarbage\n");
    expect(stat.anonBytes).toBeNull();
    expect(stat.fileBytes).toBe(200);
  });
});
