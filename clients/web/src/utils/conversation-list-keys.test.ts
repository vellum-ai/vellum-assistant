/**
 * The two facts about the generated key shape that the whole cache layer
 * stands on (see the module doc). Pinned against the real generated
 * functions and TanStack's real `partialMatchKey`, so a codegen or library
 * change that alters either shape fails here first.
 */

import { describe, expect, test } from "bun:test";
import { matchQuery, partialMatchKey } from "@tanstack/react-query";

import {
  conversationsByIdGetQueryKey,
  conversationsSectionsGetQueryKey,
  conversationsUnreadcountGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  conversationListFilterOf,
  conversationListPrefix,
  conversationListQueryKey,
  isConversationListKey,
  isSectionFilter,
} from "./conversation-list-keys";
import { queryFor } from "./conversation-list.test-helper";

const ASSISTANT_ID = "asst-1";

describe("conversationListPrefix", () => {
  test("matches every list cache for the assistant, whatever its filter", () => {
    for (const filter of [
      {},
      { conversationType: "background" as const },
      { archiveStatus: "archived" as const },
      { groupId: "system:pinned" },
      { groupId: "system:all", originChannel: "slack" as const },
      { needsAttention: "true" as const },
    ]) {
      expect(
        isConversationListKey(
          conversationListQueryKey(ASSISTANT_ID, filter),
          ASSISTANT_ID,
        ),
      ).toBe(true);
    }
  });

  test("rejects the other reads that share the assistant path", () => {
    const path = { assistant_id: ASSISTANT_ID };
    expect(
      isConversationListKey(
        conversationsByIdGetQueryKey({ path: { ...path, id: "c1" } }),
        ASSISTANT_ID,
      ),
    ).toBe(false);
    expect(
      isConversationListKey(
        conversationsSectionsGetQueryKey({ path }),
        ASSISTANT_ID,
      ),
    ).toBe(false);
    expect(
      isConversationListKey(
        conversationsUnreadcountGetQueryKey({ path }),
        ASSISTANT_ID,
      ),
    ).toBe(false);
  });

  test("rejects another assistant's list caches", () => {
    expect(
      isConversationListKey(
        conversationListQueryKey("asst-2", { groupId: "system:pinned" }),
        ASSISTANT_ID,
      ),
    ).toBe(false);
  });

  test("a cache key is a member of the prefix, never equal to it", () => {
    /* Fact 2 in the module doc. If the foreground key were the bare prefix,
       a prefix scan would find it as a phantom list. */
    expect(conversationListQueryKey(ASSISTANT_ID, {})).not.toEqual(
      conversationListPrefix(ASSISTANT_ID),
    );
    expect(conversationListFilterOf(conversationListPrefix(ASSISTANT_ID))).toBe(
      undefined,
    );
  });
});

describe("a cache key as a queryClient filter", () => {
  test("partial-matches every list whose query it is a subset of; exact does not", () => {
    /* Fact 3 in the module doc. The foreground key's `query: {}` is a
       subset of every filter, so as a non-exact filter it is the prefix. */
    const foreground = conversationListQueryKey(ASSISTANT_ID, {});
    const section = conversationListQueryKey(ASSISTANT_ID, {
      groupId: "system:pinned",
    });
    expect(partialMatchKey(section, foreground)).toBe(true);
    expect(
      matchQuery({ queryKey: foreground, exact: true }, queryFor(section)),
    ).toBe(false);
    expect(
      matchQuery({ queryKey: foreground, exact: true }, queryFor(foreground)),
    ).toBe(true);
  });
});

describe("conversationListFilterOf", () => {
  test("reads the filter straight off a list key", () => {
    const filter = { groupId: "system:all", originChannel: "slack" as const };
    expect(
      conversationListFilterOf(conversationListQueryKey(ASSISTANT_ID, filter)),
    ).toEqual(filter);
    expect(
      conversationListFilterOf(conversationListQueryKey(ASSISTANT_ID)),
    ).toEqual({});
  });

  test("is undefined for a non-list key", () => {
    expect(
      conversationListFilterOf(
        conversationsSectionsGetQueryKey({
          path: { assistant_id: ASSISTANT_ID },
        }),
      ),
    ).toBeUndefined();
    expect(conversationListFilterOf(["something", "else"])).toBeUndefined();
  });
});

describe("isSectionFilter", () => {
  test("a group or channel constraint is a section; a bare bucket is not", () => {
    expect(isSectionFilter({ groupId: "system:pinned" })).toBe(true);
    expect(isSectionFilter({ originChannel: "slack" })).toBe(true);
    expect(isSectionFilter({})).toBe(false);
    expect(isSectionFilter({ conversationType: "background" })).toBe(false);
    expect(isSectionFilter({ archiveStatus: "archived" })).toBe(false);
  });
});
