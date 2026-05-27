import { afterEach, describe, expect, mock, test } from "bun:test";

import { client } from "@/domains/intelligence/client";
import {
  ApiError,
  fetchPluginCatalog,
} from "@/domains/intelligence/plugins/api";

// ---------------------------------------------------------------------------
// fetchPluginCatalog — /v1/assistants/{id}/plugins/search/
// ---------------------------------------------------------------------------
//
// The daemon endpoint takes ?q as an ECMAScript regex (PR #31860). The web
// search input is plain text, so this fetcher regex-escapes user input
// before forwarding. These tests pin the escape + the forwarded params.
// ---------------------------------------------------------------------------

describe("fetchPluginCatalog", () => {
  const originalGet = client.get;
  afterEach(() => {
    client.get = originalGet;
  });

  test("forwards a plain query as ?q after regex-escaping specials", async () => {
    const captured: Array<Record<string, unknown>> = [];
    client.get = mock(async (req: Record<string, unknown>) => {
      captured.push(req);
      return {
        data: {
          query: "memory\\.\\(test\\)",
          ref: "main",
          matches: [],
        },
        error: null,
        response: new Response("{}", { status: 200 }),
      };
    }) as typeof client.get;

    await fetchPluginCatalog("assistant-1", { query: "memory.(test)" });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(
      "/v1/assistants/{assistant_id}/plugins/search/",
    );
    expect(captured[0]?.path).toEqual({ assistant_id: "assistant-1" });
    // Each of `.`, `(`, `)` should have been escaped.
    expect(captured[0]?.query).toEqual({ q: "memory\\.\\(test\\)" });
  });

  test("omits ?q entirely when the query is empty (match-all)", async () => {
    let capturedQuery: unknown;
    client.get = mock(async (req: Record<string, unknown>) => {
      capturedQuery = req.query;
      return {
        data: { query: "", ref: "main", matches: [] },
        error: null,
        response: new Response("{}", { status: 200 }),
      };
    }) as typeof client.get;

    await fetchPluginCatalog("assistant-1", { query: "" });

    expect(capturedQuery).toEqual({});
  });

  test("forwards ref when provided", async () => {
    let capturedQuery: Record<string, string> | undefined;
    client.get = mock(async (req: Record<string, unknown>) => {
      capturedQuery = req.query as Record<string, string>;
      return {
        data: { query: "", ref: "feature-x", matches: [] },
        error: null,
        response: new Response("{}", { status: 200 }),
      };
    }) as typeof client.get;

    await fetchPluginCatalog("assistant-1", { ref: "feature-x" });

    expect(capturedQuery).toEqual({ ref: "feature-x" });
  });

  test("returns the parsed envelope on success", async () => {
    client.get = mock(async () => ({
      data: {
        query: "mem",
        ref: "main",
        matches: [
          { name: "simple-memory", path: "experimental/plugins/simple-memory" },
        ],
      },
      error: null,
      response: new Response("{}", { status: 200 }),
    })) as typeof client.get;

    const result = await fetchPluginCatalog("assistant-1", { query: "mem" });

    expect(result.matches).toEqual([
      { name: "simple-memory", path: "experimental/plugins/simple-memory" },
    ]);
    expect(result.ref).toBe("main");
  });

  test("throws ApiError on non-ok responses (no 404 fallback)", async () => {
    client.get = mock(async () => ({
      data: undefined,
      error: { error: "endpoint not found" },
      response: new Response(JSON.stringify({ error: "endpoint not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    })) as typeof client.get;

    let thrown: unknown;
    try {
      await fetchPluginCatalog("assistant-1");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(404);
  });

  test("throws ApiError on 500", async () => {
    client.get = mock(async () => ({
      data: undefined,
      error: { error: "boom" },
      response: new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    })) as typeof client.get;

    let thrown: unknown;
    try {
      await fetchPluginCatalog("assistant-1", { query: "mem" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(500);
  });
});
