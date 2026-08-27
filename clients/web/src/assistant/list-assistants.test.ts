/**
 * `listAssistants` follows the platform's `next` chain so an org past one
 * page size lists every assistant; the chooser and the avatar lookup both
 * read this wrapper.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

type ListCall = {
  query?: { hosting?: string; limit?: number; offset?: number };
};
type Page = {
  data?: { results: { id: string }[]; next: string | null };
  error?: unknown;
  response: { ok: boolean; status: number };
};

const pages: Page[] = [];
const assistantsList = mock(async (_opts: ListCall): Promise<Page> => {
  const page = pages.shift();
  if (!page) {
    throw new Error("unexpected extra page request");
  }
  return page;
});

const noop = mock(async () => ({
  data: undefined,
  error: undefined,
  response: { ok: true, status: 200 },
}));
mock.module("@/generated/api/sdk.gen", () => ({
  assistantsActivateCreate: noop,
  assistantsBackupsCreate: noop,
  assistantsBackupsRestoreCreate: noop,
  assistantsBackupsRetrieve: noop,
  assistantsHatchCreate: noop,
  assistantsList,
  assistantsRestartDetailCreate: noop,
  assistantsRetireDetailDestroy: noop,
  assistantsRetireDestroy: noop,
  assistantsRetrieve: noop,
}));

const { listAssistants } = await import("./api");

const ok = (ids: string[], next: string | null): Page => ({
  data: { results: ids.map((id) => ({ id })), next },
  response: { ok: true, status: 200 },
});

beforeEach(() => {
  pages.length = 0;
  assistantsList.mockClear();
});

describe("listAssistants", () => {
  test("a single page is returned as-is", async () => {
    pages.push(ok(["a", "b"], null));
    const result = await listAssistants();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((a) => a.id)).toEqual(["a", "b"]);
    }
    expect(assistantsList).toHaveBeenCalledTimes(1);
    expect(assistantsList.mock.calls[0]?.[0].query).toEqual({
      hosting: "all",
      limit: 100,
      offset: 0,
    });
  });

  test("follows next with an offset until the chain ends", async () => {
    pages.push(ok(["a", "b"], "…?offset=2"), ok(["c"], null));
    const result = await listAssistants();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((a) => a.id)).toEqual(["a", "b", "c"]);
    }
    expect(assistantsList).toHaveBeenCalledTimes(2);
    expect(assistantsList.mock.calls[1]?.[0].query?.offset).toBe(2);
  });

  test("an empty page ends the chain even when next is set", async () => {
    pages.push(ok(["a"], "…?offset=1"), ok([], "…?offset=1"));
    const result = await listAssistants();
    expect(result.ok && result.data.length).toBe(1);
    expect(assistantsList).toHaveBeenCalledTimes(2);
  });

  test("a chain still open at the page cap fails rather than truncating", async () => {
    for (let i = 0; i < 20; i++) {
      pages.push(ok([`a${i}`], "…?more"));
    }
    const result = await listAssistants();
    expect(result.ok).toBe(false);
    expect(assistantsList).toHaveBeenCalledTimes(20);
  });

  test("a failed later page fails the whole list", async () => {
    pages.push(ok(["a"], "…?offset=1"), {
      error: { detail: "nope" },
      response: { ok: false, status: 500 },
    });
    const result = await listAssistants();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
    }
  });
});
