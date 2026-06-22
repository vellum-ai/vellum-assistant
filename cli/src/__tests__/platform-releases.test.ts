import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  fetchReleases,
  resolveImageRefsDetailed,
} from "../lib/platform-releases.js";

const originalFetch = globalThis.fetch;

function mockFetchJson(body: unknown, status = 200) {
  const fetchMock = mock(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status }),
  );
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

function mockFetchError() {
  globalThis.fetch = mock(async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  process.env.VELLUM_PLATFORM_URL = "https://platform.test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.VELLUM_PLATFORM_URL;
});

const RELEASE = {
  version: "0.7.0",
  assistant_image_ref: "gcr.io/vellum/assistant@sha256:aaa",
  gateway_image_ref: "gcr.io/vellum/gateway@sha256:bbb",
  credential_executor_image_ref: "gcr.io/vellum/ces@sha256:ccc",
};

describe("fetchReleases", () => {
  test("defaults to stable=true and returns the list", async () => {
    const fetchMock = mockFetchJson([RELEASE]);
    const releases = await fetchReleases();
    expect(releases).toEqual([RELEASE]);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/v1/releases/?stable=true");
    expect(url).toContain("limit=100");
  });

  test("passes the channel param when given", async () => {
    const fetchMock = mockFetchJson([RELEASE]);
    await fetchReleases({ channel: "preview" });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/v1/releases/?channel=preview");
    expect(url).toContain("limit=100");
  });

  test("uses the platformUrl override over the resolved default", async () => {
    const fetchMock = mockFetchJson([RELEASE]);
    await fetchReleases({ platformUrl: "https://other-platform.test" });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("https://other-platform.test/v1/releases/");
  });

  test("returns null on non-OK response", async () => {
    mockFetchJson({ detail: "nope" }, 500);
    expect(await fetchReleases()).toBeNull();
  });

  test("returns null on network error", async () => {
    mockFetchError();
    expect(await fetchReleases()).toBeNull();
  });
});

describe("resolveImageRefsDetailed", () => {
  test("returns platform refs when the version is found", async () => {
    mockFetchJson([RELEASE]);
    const result = await resolveImageRefsDetailed("v0.7.0");
    expect(result.status).toBe("platform");
    if (result.status === "platform") {
      expect(result.imageTags.assistant).toBe(RELEASE.assistant_image_ref);
      expect(result.imageTags.gateway).toBe(RELEASE.gateway_image_ref);
    }
  });

  test("falls back to DockerHub for a null credential-executor ref", async () => {
    mockFetchJson([{ ...RELEASE, credential_executor_image_ref: null }]);
    const result = await resolveImageRefsDetailed("0.7.0");
    expect(result.status).toBe("platform");
    if (result.status === "platform") {
      expect(result.imageTags["credential-executor"]).toContain(":0.7.0");
    }
  });

  test("returns version-not-found when the platform list lacks the version", async () => {
    mockFetchJson([RELEASE]);
    const result = await resolveImageRefsDetailed("v9.9.9");
    expect(result.status).toBe("version-not-found");
  });

  test("returns dockerhub-fallback when the platform is unreachable", async () => {
    mockFetchError();
    const result = await resolveImageRefsDetailed("v0.7.0");
    expect(result.status).toBe("dockerhub-fallback");
    if (result.status === "dockerhub-fallback") {
      expect(result.imageTags.assistant).toContain(":v0.7.0");
    }
  });

  test("returns dockerhub-fallback when required refs are missing", async () => {
    mockFetchJson([{ ...RELEASE, assistant_image_ref: null }]);
    const result = await resolveImageRefsDetailed("0.7.0");
    expect(result.status).toBe("dockerhub-fallback");
  });
});
