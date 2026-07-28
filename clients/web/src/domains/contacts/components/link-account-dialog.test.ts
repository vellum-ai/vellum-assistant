import { describe, expect, test } from "bun:test";

import type { RosterAccount } from "@/domains/contacts/channel-linking";
import { filterRosterAccounts } from "@/domains/contacts/components/link-account-dialog";

const ROSTER: RosterAccount[] = [
  { id: "U1", username: "alice", displayName: "Alice Smith", imageUrl: null },
  { id: "U2", username: "bob", displayName: "Bob Jones", imageUrl: null },
  {
    id: "U3",
    username: "asmith2",
    displayName: "Anna Smithers",
    imageUrl: null,
  },
];

describe("filterRosterAccounts", () => {
  test("empty search returns everyone", () => {
    expect(filterRosterAccounts(ROSTER, "  ")).toEqual(ROSTER);
  });

  test("matches display name case-insensitively", () => {
    expect(filterRosterAccounts(ROSTER, "aLiCe").map((u) => u.id)).toEqual([
      "U1",
    ]);
  });

  test("matches @handle with or without the leading @", () => {
    expect(filterRosterAccounts(ROSTER, "@bob").map((u) => u.id)).toEqual([
      "U2",
    ]);
    expect(filterRosterAccounts(ROSTER, "bob").map((u) => u.id)).toEqual([
      "U2",
    ]);
  });

  test("substring matches across both fields", () => {
    expect(filterRosterAccounts(ROSTER, "smith").map((u) => u.id)).toEqual([
      "U1",
      "U3",
    ]);
  });
});
