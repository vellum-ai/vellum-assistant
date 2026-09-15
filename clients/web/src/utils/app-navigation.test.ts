/**
 * The entry an open app records so its close can pop back through it. The
 * cases are the ones that decide pop or replace: the conversation the app is
 * opening on (with the spellings the router matches), a route already naming
 * an app, another conversation, and an entry carrying a one-shot param. The
 * re-key a replace carries onto the entry is pinned alongside them.
 */

import { describe, expect, test } from "bun:test";

import {
  appEntryState,
  carriedAppEntryState,
  hasAppReturnEntry,
} from "@/utils/app-navigation";
import {
  ESCAPED_CONVERSATIONS_PREFIX,
  ESCAPED_PREFIX_APP_PATH,
} from "@/utils/routes.test-helper";
import { routes } from "@/utils/routes";

const APP_ID = "app-1";
const CONV_ID = "conv-origin";
const CONVERSATION_PATH = routes.conversation(CONV_ID);

describe("appEntryState", () => {
  test.each([
    CONVERSATION_PATH,
    `${CONVERSATION_PATH}/`,
    `${ESCAPED_CONVERSATIONS_PREFIX}/${CONV_ID}`,
  ])("records the conversation the app opens on from %s", (pathname) => {
    const state = appEntryState({ pathname, search: "" }, APP_ID, CONV_ID);

    expect(state?.appEntry).toEqual({
      appId: APP_ID,
      returnTo: CONVERSATION_PATH,
    });
    expect(hasAppReturnEntry(state, APP_ID, CONVERSATION_PATH)).toBe(true);
  });

  test.each([ESCAPED_PREFIX_APP_PATH, routes.conversation(CONV_ID, "app-2")])(
    "records nothing from %s, which already names an app",
    (pathname) => {
      expect(
        appEntryState({ pathname, search: "" }, APP_ID, CONV_ID),
      ).toBeUndefined();
    },
  );

  test.each(["prompt=send", "relay=again", "document=surface-2"])(
    "records nothing for an entry carrying %s",
    (search) => {
      expect(
        appEntryState(
          { pathname: CONVERSATION_PATH, search: `?${search}` },
          APP_ID,
          CONV_ID,
        ),
      ).toBeUndefined();
    },
  );

  test.each([routes.conversation("conv-other"), routes.library.root])(
    "records nothing from %s, which is not the app's conversation",
    (pathname) => {
      expect(
        appEntryState({ pathname, search: "" }, APP_ID, CONV_ID),
      ).toBeUndefined();
    },
  );
});

describe("hasAppReturnEntry", () => {
  const state = appEntryState(
    { pathname: CONVERSATION_PATH, search: "" },
    APP_ID,
    CONV_ID,
  );

  test("matches on both the app and the destination", () => {
    expect(hasAppReturnEntry(state, "app-2", CONVERSATION_PATH)).toBe(false);
    expect(
      hasAppReturnEntry(state, APP_ID, routes.conversation("conv-other")),
    ).toBe(false);
  });

  test.each([
    null,
    undefined,
    "appEntry",
    { appEntry: null },
    { appEntry: {} },
  ])("rejects malformed state %p", (malformed) => {
    expect(hasAppReturnEntry(malformed, APP_ID, CONVERSATION_PATH)).toBe(false);
  });
});

describe("carriedAppEntryState", () => {
  const state = appEntryState(
    { pathname: CONVERSATION_PATH, search: "" },
    APP_ID,
    CONV_ID,
  );

  test("re-keys the return path to the conversation the entry now names", () => {
    const carried = carriedAppEntryState(state, "conv-server-1");

    expect(carried).toEqual({
      appEntry: {
        appId: APP_ID,
        returnTo: routes.conversation("conv-server-1"),
      },
    });
    expect(
      hasAppReturnEntry(carried, APP_ID, routes.conversation("conv-server-1")),
    ).toBe(true);
  });

  test.each([null, undefined, "appEntry", 7, {}, { appEntry: {} }])(
    "carries nothing from %p, which records no entry",
    (stateless) => {
      expect(carriedAppEntryState(stateless, CONV_ID)).toBeUndefined();
    },
  );
});
