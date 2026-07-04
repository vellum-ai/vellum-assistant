import { describe, expect, test } from "bun:test";

import { parseSlabinfo } from "../slabinfo.js";

const SLABINFO = `slabinfo - version: 2.1
# name            <active_objs> <num_objs> <objsize> <objperslab> <pagesperslab> : tunables <limit> <batchcount> <sharedfactor> : slabdata <active_slabs> <num_slabs> <sharedavail>
fuse_inode        820000 825000    832   39    8 : tunables    0    0    0 : slabdata  21154  21154      0
dentry            780000 782000    192   21    1 : tunables    0    0    0 : slabdata  37238  37238      0
ext4_groupinfo_4k   2054   2054    152   26    1 : tunables    0    0    0 : slabdata     79     79      0
nf_conntrack           0      0    256   16    1 : tunables    0    0    0 : slabdata      0      0      0
`;

describe("parseSlabinfo", () => {
  test("parses caches and sorts by held memory, largest first", () => {
    const caches = parseSlabinfo(SLABINFO);

    expect(caches.map((c) => c.name)).toEqual([
      "fuse_inode",
      "dentry",
      "ext4_groupinfo_4k",
      "nf_conntrack",
    ]);
    expect(caches[0]).toEqual({
      name: "fuse_inode",
      activeObjs: 820000,
      numObjs: 825000,
      objSizeBytes: 832,
      totalBytes: 825000 * 832,
    });
    expect(caches[1].totalBytes).toBe(782000 * 192);
  });

  test("skips headers and malformed lines", () => {
    expect(parseSlabinfo("")).toEqual([]);
    expect(
      parseSlabinfo("slabinfo - version: 2.1\n# name legend\nshort line\n"),
    ).toEqual([]);
    expect(parseSlabinfo("bad notanumber 5 10 1 : tunables 0 0 0\n")).toEqual(
      [],
    );
  });
});
