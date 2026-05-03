import { beforeEach, describe, expect, mock, test } from "bun:test";

type WarnCall = [unknown, string?] | [string];

const warnCalls: WarnCall[] = [];

mock.module("../logger.js", () => {
  const fakeLogger = {
    warn: (...args: WarnCall) => {
      warnCalls.push(args);
    },
    info: () => undefined,
    debug: () => undefined,
    error: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
    child: () => fakeLogger,
  };
  return {
    getLogger: () => fakeLogger,
    initLogger: () => undefined,
  };
});

const { warnOnMissingSlackScopes } = await import("../slack/socket-mode.js");

function warnedMessages(): string[] {
  return warnCalls.map((call) =>
    typeof call[0] === "string"
      ? (call[0] as string)
      : ((call[1] ?? "") as string),
  );
}

function warnedMissingHistoryScopes(): string[] {
  for (const call of warnCalls) {
    if (typeof call[0] === "object" && call[0] !== null) {
      const ctx = call[0] as { missingHistoryScopes?: string[] };
      if (ctx.missingHistoryScopes) return ctx.missingHistoryScopes;
    }
  }
  return [];
}

describe("warnOnMissingSlackScopes", () => {
  beforeEach(() => {
    warnCalls.length = 0;
  });

  test("warns when files:read is missing", () => {
    warnOnMissingSlackScopes(
      "app_mentions:read,channels:history,im:history,groups:history,mpim:history",
    );
    expect(warnedMessages().some((msg) => msg.includes("'files:read'"))).toBe(
      true,
    );
  });

  test("warns when any *:history scope is missing and lists exactly the missing ones", () => {
    warnOnMissingSlackScopes("app_mentions:read,files:read,channels:history");
    expect(warnedMessages().some((msg) => msg.includes("*:history"))).toBe(
      true,
    );
    expect(warnedMissingHistoryScopes().sort()).toEqual([
      "groups:history",
      "im:history",
      "mpim:history",
    ]);
  });

  test("emits no warnings when all required scopes are present", () => {
    warnOnMissingSlackScopes(
      "app_mentions:read,files:read,channels:history,im:history,groups:history,mpim:history",
    );
    expect(warnCalls).toHaveLength(0);
  });

  test("treats an empty scope header as everything missing", () => {
    warnOnMissingSlackScopes("");
    const messages = warnedMessages();
    expect(messages.some((msg) => msg.includes("'files:read'"))).toBe(true);
    expect(warnedMissingHistoryScopes().sort()).toEqual([
      "channels:history",
      "groups:history",
      "im:history",
      "mpim:history",
    ]);
  });
});
