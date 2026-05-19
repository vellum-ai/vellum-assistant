import { describe, expect, test } from "bun:test";

import type { ConversationGroup } from "@/domains/chat/lib/api.js";

import { patchGroup } from "@/domains/chat/hooks/use-conversation-group-actions.js";

const groups: ConversationGroup[] = [
  { id: "g1", name: "Work", sortPosition: 0, isSystemGroup: false },
  { id: "g2", name: "Personal", sortPosition: 1, isSystemGroup: false },
  { id: "g3", name: "System", sortPosition: 2, isSystemGroup: true },
];

describe("patchGroup", () => {
  test("patches the matching group and leaves others untouched", () => {
    const result = patchGroup(groups, "g2", { name: "Home" });
    expect(result).toHaveLength(3);
    expect(result[0]).toStrictEqual(groups[0]);
    expect(result[1]).toStrictEqual({ id: "g2", name: "Home", sortPosition: 1, isSystemGroup: false });
    expect(result[2]).toStrictEqual(groups[2]);
  });

  test("returns value-equal array when no id matches", () => {
    const result = patchGroup(groups, "nonexistent", { name: "X" });
    expect(result).toEqual(groups);
  });

  test("applies multiple fields at once", () => {
    const result = patchGroup(groups, "g1", { name: "Updated", sortPosition: 5 });
    expect(result[0]).toStrictEqual({ id: "g1", name: "Updated", sortPosition: 5, isSystemGroup: false });
  });

  test("does not mutate the original array", () => {
    const original = groups.map((g) => ({ ...g }));
    patchGroup(groups, "g1", { name: "Changed" });
    expect(groups).toEqual(original);
  });
});
