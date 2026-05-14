import { describe, expect, test } from "bun:test";

import { inspectSlackScopes } from "../slack/socket-mode.js";

describe("inspectSlackScopes", () => {
  test("flags files:read when missing", () => {
    const result = inspectSlackScopes(
      "app_mentions:read,channels:history,im:history,groups:history,mpim:history,channels:read,im:read,groups:read,mpim:read",
    );
    expect(result.filesReadMissing).toBe(true);
    expect(result.missingHistoryScopes).toEqual([]);
    expect(result.missingConversationInfoScopes).toEqual([]);
  });

  test("returns exactly the missing *:history scopes", () => {
    const result = inspectSlackScopes(
      "app_mentions:read,files:read,channels:history,channels:read,im:read,groups:read,mpim:read",
    );
    expect(result.filesReadMissing).toBe(false);
    expect(result.missingHistoryScopes.sort()).toEqual([
      "groups:history",
      "im:history",
      "mpim:history",
    ]);
    expect(result.missingConversationInfoScopes).toEqual([]);
  });

  test("returns exactly the missing *:read scopes for conversations.info", () => {
    const result = inspectSlackScopes(
      "app_mentions:read,files:read,channels:history,im:history,groups:history,mpim:history,channels:read",
    );
    expect(result.filesReadMissing).toBe(false);
    expect(result.missingHistoryScopes).toEqual([]);
    expect(result.missingConversationInfoScopes.sort()).toEqual([
      "groups:read",
      "im:read",
      "mpim:read",
    ]);
  });

  test("returns no missing scopes when all required are present", () => {
    const result = inspectSlackScopes(
      "app_mentions:read,files:read,channels:history,im:history,groups:history,mpim:history,channels:read,im:read,groups:read,mpim:read",
    );
    expect(result.filesReadMissing).toBe(false);
    expect(result.missingHistoryScopes).toEqual([]);
    expect(result.missingConversationInfoScopes).toEqual([]);
  });

  test("treats an empty scope header as everything missing", () => {
    const result = inspectSlackScopes("");
    expect(result.filesReadMissing).toBe(true);
    expect(result.missingHistoryScopes.sort()).toEqual([
      "channels:history",
      "groups:history",
      "im:history",
      "mpim:history",
    ]);
    expect(result.missingConversationInfoScopes.sort()).toEqual([
      "channels:read",
      "groups:read",
      "im:read",
      "mpim:read",
    ]);
  });

  test("ignores whitespace and empty entries in the header", () => {
    const result = inspectSlackScopes(
      " files:read , channels:history,, im:history ,groups:history,mpim:history, channels:read, im:read, groups:read, mpim:read",
    );
    expect(result.filesReadMissing).toBe(false);
    expect(result.missingHistoryScopes).toEqual([]);
    expect(result.missingConversationInfoScopes).toEqual([]);
  });
});
