import { describe, expect, test } from "bun:test";

import { fixtureNotFound, stubClientFetch } from "@/lib/stub-client-fetch";

interface FakeConfig {
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

function fakeClient(initial: FakeConfig) {
  let config = initial;
  return {
    getConfig: () => config,
    setConfig: (next: FakeConfig) => {
      config = next;
      return config;
    },
  };
}

describe("stubClientFetch", () => {
  test("routes the client's fetch to the handler as a Request and restores on cleanup", async () => {
    const client = fakeClient({
      baseUrl: "https://real.example",
      headers: { a: "1" },
    });
    const seen: string[] = [];
    const restore = stubClientFetch(client, (request) => {
      seen.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ ok: true });
    });

    const stubbed = client.getConfig();
    expect(stubbed.baseUrl).toBe("https://storybook.invalid");
    expect(stubbed.headers).toEqual({ a: "1" });
    const response = await stubbed.fetch!(
      "https://storybook.invalid/v1/things",
      {
        method: "POST",
      },
    );
    expect(await response.json()).toEqual({ ok: true });
    expect(seen).toEqual(["POST /v1/things"]);

    restore();
    expect(client.getConfig().baseUrl).toBe("https://real.example");
    expect(client.getConfig().fetch).toBeUndefined();
  });

  test("passes a Request through untouched, body included", async () => {
    const client = fakeClient({});
    stubClientFetch(client, async (request) =>
      Response.json(await request.json()),
    );
    const request = new Request("https://storybook.invalid/echo", {
      method: "POST",
      body: JSON.stringify({ n: 2 }),
    });
    const response = await client.getConfig().fetch!(request);
    expect(await response.json()).toEqual({ n: 2 });
  });

  test("fixtureNotFound is a 404", async () => {
    expect(fixtureNotFound().status).toBe(404);
  });
});
