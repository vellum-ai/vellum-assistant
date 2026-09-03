/**
 * Unit tests for the roadmap route handlers: assistant-key auth (anonymous
 * reads, connect-first writes), request shaping against the marketing API, and
 * the camelCase payload the CLI renders.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { UnprocessableEntityError } from "../errors.js";
import type { RouteDefinition } from "../types.js";

let storedApiKey: string | undefined = "assistant-key";

const actualSecureKeys = await import("../../../security/secure-keys.js");
mock.module("../../../security/secure-keys.js", () => ({
  ...actualSecureKeys,
  getSecureKeyAsync: async (account: string) =>
    account === "credential/vellum/assistant_api_key"
      ? storedApiKey
      : undefined,
}));

const { ROUTES } = await import("../roadmap-routes.js");

function route(operationId: string, method: string): RouteDefinition {
  const found = ROUTES.find(
    (r) => r.operationId === operationId && r.method === method,
  );
  if (!found) {
    throw new Error(`no route ${operationId} ${method}`);
  }
  return found;
}

const list = route("roadmap_list", "GET").handler;
const get = route("roadmap_get", "GET").handler;
const create = route("roadmap_create", "POST").handler;
const update = route("roadmap_update", "PATCH").handler;
const remove = route("roadmap_delete", "DELETE").handler;
const upvote = route("roadmap_upvote", "POST").handler;
const unvote = route("roadmap_unvote", "DELETE").handler;

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal | null;
}

const realFetch = globalThis.fetch;
let calls: RecordedCall[] = [];

/** Stub globalThis.fetch to answer every call with `body`, recording requests. */
function stubFetch(body: unknown, status = 200): void {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      signal: init?.signal,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

const UPSTREAM_ITEM = {
  slug: "dark-mode",
  title: "Add dark mode",
  status: "open",
  upvote_count: 12,
  comment_count: 2,
  tags: [{ slug: "ui", name: "UI" }],
  viewer_upvoted: true,
};

beforeEach(() => {
  storedApiKey = "assistant-key";
  calls = [];
  process.env.VELLUM_MARKETING_URL = "https://marketing.test";
  process.env.VELLUM_WEB_URL = "https://web.test";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.VELLUM_MARKETING_URL;
  delete process.env.VELLUM_WEB_URL;
  delete process.env.VELLUM_ENVIRONMENT;
});

describe("which deployment the roadmap calls reach", () => {
  test("production needs no configuration", async () => {
    delete process.env.VELLUM_MARKETING_URL;
    process.env.VELLUM_ENVIRONMENT = "production";
    stubFetch({ items: [], total: 0 });

    await list({});

    expect(calls[0].url).toBe("https://marketing.vellum.ai/v1/roadmap");
  });

  test("an unconfigured non-production assistant refuses rather than writing to the public roadmap", async () => {
    delete process.env.VELLUM_MARKETING_URL;
    process.env.VELLUM_ENVIRONMENT = "staging";
    stubFetch({ items: [], total: 0 });

    await expect(list({})).rejects.toThrow(
      "The Vellum roadmap has no staging deployment",
    );
    expect(calls).toHaveLength(0);
  });

  test("a named endpoint is honored in any environment", async () => {
    process.env.VELLUM_ENVIRONMENT = "dev";
    stubFetch({ items: [], total: 0 });

    await list({});

    expect(calls[0].url).toBe("https://marketing.test/v1/roadmap");
  });
});

describe("roadmap reads", () => {
  test("list forwards filters and maps the item into camelCase", async () => {
    stubFetch({ items: [UPSTREAM_ITEM], total: 30 });

    const result = (await list({
      queryParams: { q: "dark", sort: "upvotes", limit: "5" },
    })) as { items: { url: string; upvoteCount: number }[]; total: number };

    expect(calls[0].url).toBe(
      "https://marketing.test/v1/roadmap?q=dark&sort=upvotes&limit=5",
    );
    expect(result.total).toBe(30);
    expect(result.items[0]).toMatchObject({
      slug: "dark-mode",
      upvoteCount: 12,
      commentCount: 2,
      viewerUpvoted: true,
      url: "https://web.test/roadmap/dark-mode",
      tags: [{ slug: "ui", name: "UI" }],
    });
  });

  test("list omits filters that were not supplied", async () => {
    stubFetch({ items: [], total: 0 });

    await list({ queryParams: { status: "planned" } });

    expect(calls[0].url).toBe(
      "https://marketing.test/v1/roadmap?status=planned",
    );
  });

  test("a read authenticates as the assistant when a key is stored", async () => {
    stubFetch({ items: [], total: 0 });

    await list({});

    expect(calls[0].headers.Authorization).toBe("Api-Key assistant-key");
  });

  test("a read falls back to anonymous with no key stored", async () => {
    storedApiKey = undefined;
    stubFetch({ items: [], total: 0 });

    await list({});

    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  test("get returns the comment thread with author kinds resolved", async () => {
    stubFetch({
      ...UPSTREAM_ITEM,
      description: "Follow the OS setting",
      creator_username: "aria",
      creator_kind: "assistant",
      created: "2026-09-01T00:00:00Z",
      comments: [
        {
          id: "c1",
          author_username: "sam",
          author_is_staff: true,
          body: "Planned",
          created: "2026-09-02T00:00:00Z",
        },
      ],
    });

    const item = (await get({ pathParams: { slug: "dark-mode" } })) as {
      creatorKind: string | null;
      comments: { authorKind: string | null; authorIsStaff: boolean }[];
    };

    expect(calls[0].url).toBe("https://marketing.test/v1/roadmap/dark-mode");
    expect(item.creatorKind).toBe("assistant");
    expect(item.comments[0]).toMatchObject({
      authorKind: null,
      authorIsStaff: true,
      body: "Planned",
    });
  });

  test("a slug is escaped into the upstream path", async () => {
    stubFetch({ ...UPSTREAM_ITEM, creator_username: "a", created: "x" });

    await get({ pathParams: { slug: "a b/../c" } });

    expect(calls[0].url).toBe(
      "https://marketing.test/v1/roadmap/a%20b%2F..%2Fc",
    );
  });
});

describe("roadmap writes", () => {
  test("create posts only the fields that were supplied", async () => {
    stubFetch(UPSTREAM_ITEM);

    await create({ body: { title: "Add dark mode", tags: ["ui"] } });

    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ title: "Add dark mode", tags: ["ui"] });
  });

  test("a mutation answers with the identity the upstream actually returns", async () => {
    // What the marketing API sends back on a write: no counts, no tags.
    stubFetch({ slug: "dark-mode", title: "Add dark mode", status: "open" });

    const created = await create({ body: { title: "Add dark mode" } });

    expect(created).toEqual({
      slug: "dark-mode",
      title: "Add dark mode",
      status: "open",
      url: "https://web.test/roadmap/dark-mode",
    });
  });

  test("update can clear every tag", async () => {
    stubFetch(UPSTREAM_ITEM);

    await update({ pathParams: { slug: "dark-mode" }, body: { tags: [] } });

    expect(calls[0].body).toEqual({ tags: [] });
  });

  test("create rejects a blank title before calling out", async () => {
    stubFetch(UPSTREAM_ITEM);

    await expect(create({ body: { title: "  " } })).rejects.toThrow(
      "title is required",
    );
    expect(calls).toHaveLength(0);
  });

  test("update rejects an empty patch before calling out", async () => {
    stubFetch(UPSTREAM_ITEM);

    await expect(
      update({ pathParams: { slug: "dark-mode" }, body: {} }),
    ).rejects.toThrow("At least one of");
    expect(calls).toHaveLength(0);
  });

  test("update sends just the changed fields", async () => {
    stubFetch(UPSTREAM_ITEM);

    await update({
      pathParams: { slug: "dark-mode" },
      body: { status: "planned" },
    });

    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].body).toEqual({ status: "planned" });
  });

  test("delete reports the removed slug", async () => {
    stubFetch({});

    const result = await remove({ pathParams: { slug: "dark-mode" } });

    expect(calls[0].method).toBe("DELETE");
    expect(result).toEqual({ slug: "dark-mode", deleted: true });
  });

  test("upvote and unvote share the upvote path and differ by method", async () => {
    stubFetch({ slug: "dark-mode", upvote_count: 13 });
    const upvoted = await upvote({ pathParams: { slug: "dark-mode" } });

    stubFetch({ slug: "dark-mode", upvote_count: 12 });
    const unvoted = await unvote({ pathParams: { slug: "dark-mode" } });

    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["POST", "https://marketing.test/v1/roadmap/dark-mode/upvote"],
      ["DELETE", "https://marketing.test/v1/roadmap/dark-mode/upvote"],
    ]);
    expect(upvoted).toEqual({ slug: "dark-mode", upvoteCount: 13 });
    expect(unvoted).toEqual({ slug: "dark-mode", upvoteCount: 12 });
  });

  test("every write refuses to run unauthenticated", async () => {
    storedApiKey = undefined;
    stubFetch(UPSTREAM_ITEM);

    const writes = [
      () => create({ body: { title: "Add dark mode" } }),
      () =>
        update({ pathParams: { slug: "dark-mode" }, body: { status: "open" } }),
      () => remove({ pathParams: { slug: "dark-mode" } }),
      () => upvote({ pathParams: { slug: "dark-mode" } }),
      () => unvote({ pathParams: { slug: "dark-mode" } }),
    ];

    for (const write of writes) {
      await expect(write()).rejects.toThrow(UnprocessableEntityError);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("upstream failures", () => {
  test("a 404 surfaces as a not-found route error", async () => {
    stubFetch({ detail: "No such item" }, 404);

    await expect(get({ pathParams: { slug: "nope" } })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  test("a rejected key surfaces as forbidden, not as a 500", async () => {
    stubFetch({ detail: "Invalid key" }, 401);

    await expect(
      create({ body: { title: "Add dark mode" } }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test("a 5xx surfaces as a bad-gateway route error", async () => {
    stubFetch({ detail: "boom" }, 503);

    await expect(list({})).rejects.toMatchObject({ statusCode: 502 });
  });

  test("every request is armed with a deadline, so none can hang", async () => {
    stubFetch({ items: [], total: 0 });

    await list({});

    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  test("a caller that gives up takes the upstream request with it", async () => {
    stubFetch({ items: [], total: 0 });

    await list({ abortSignal: AbortSignal.abort() });

    expect(calls[0].signal?.aborted).toBe(true);
  });

  test("an unreachable roadmap service does not leak a raw fetch error", async () => {
    globalThis.fetch = (async (
      _input: string | URL | Request,
    ): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    await expect(list({})).rejects.toThrow(
      "Could not reach the Vellum roadmap service",
    );
  });
});
