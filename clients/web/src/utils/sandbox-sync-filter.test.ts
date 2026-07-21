import { describe, expect, test } from "bun:test";

import { forwardableSyncTags, isReservedSyncTag } from "./sandbox-sync-filter";

describe("forwardableSyncTags", () => {
  test("delivers a custom tag the app subscribed to", () => {
    expect(forwardableSyncTags(["show:state"], ["show:state"])).toEqual([
      "show:state",
    ]);
  });

  test("delivers only the intersection of subscribed and event tags", () => {
    expect(forwardableSyncTags(["a", "b"], ["b", "c"])).toEqual(["b"]);
  });

  test("an empty subscription receives nothing (default-deny)", () => {
    expect(forwardableSyncTags([], ["show:state"])).toEqual([]);
  });

  test("never forwards reserved host namespaces, even if explicitly subscribed", () => {
    const reserved = [
      "assistant:self:theme",
      "conversation:conv-1:messages",
      "conversations:list",
      "apps:list",
      "plugins:list",
      "feature-flags:client",
    ];
    expect(forwardableSyncTags(reserved, reserved)).toEqual([]);
    for (const tag of reserved) {
      expect(isReservedSyncTag(tag)).toBe(true);
    }
  });

  test("keeps custom tags while dropping reserved ones in the same event", () => {
    expect(
      forwardableSyncTags(
        ["show:state", "apps:list"],
        ["show:state", "apps:list"],
      ),
    ).toEqual(["show:state"]);
  });

  test("custom app tags are not reserved", () => {
    expect(isReservedSyncTag("show:state")).toBe(false);
    expect(isReservedSyncTag("my-app:data")).toBe(false);
  });
});
