import { describe, expect, test } from "bun:test";

import {
  type FetchLike,
  HOST_IMAGE_LOADER_URL,
  HostImageLoaderError,
  isLocalBuildRef,
  loadImageViaHost,
} from "../lib/host-image-loader.js";

describe("HOST_IMAGE_LOADER_URL", () => {
  test("resolves to the well-known image-loader port/path", () => {
    expect(HOST_IMAGE_LOADER_URL).toBe("http://127.0.0.1:5500/v1/images/load");
  });
});

describe("isLocalBuildRef", () => {
  test("recognizes the `vellum-local/` prefix as a local build", () => {
    expect(isLocalBuildRef("vellum-local/assistant-server:sha-abc123")).toBe(
      true,
    );
    expect(isLocalBuildRef("vellum-local/gateway:sha-def")).toBe(true);
  });

  test("treats external registry refs as pullable", () => {
    expect(isLocalBuildRef("docker.io/example/image:v0.8.2")).toBe(false);
    expect(
      isLocalBuildRef("us-east1-docker.pkg.dev/example/image@sha256:deadbeef"),
    ).toBe(false);
    expect(isLocalBuildRef("postgres:17")).toBe(false);
  });
});

function silentLog(_msg: string): void {
  // intentionally swallow logs in test
}

function makeFetch(
  responses: Array<{ url: string; body: unknown; status: number }>,
  recordedRequests: Array<{ url: string; body: unknown }>,
): FetchLike {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body) : null;
    recordedRequests.push({ url, body });
    const planned = responses.shift();
    if (!planned) throw new Error(`unexpected request to ${url}`);
    return new Response(JSON.stringify(planned.body), {
      status: planned.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("loadImageViaHost", () => {
  test("POSTs {ref} to the URL and resolves on 200", async () => {
    const recorded: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = makeFetch(
      [
        {
          url: "http://127.0.0.1:5500/v1/images/load",
          body: {
            loaded: true,
            ref: "vellum-local/assistant:sha-abc",
          },
          status: 200,
        },
      ],
      recorded,
    );

    await loadImageViaHost(
      "http://127.0.0.1:5500/v1/images/load",
      "vellum-local/assistant:sha-abc",
      silentLog,
      { fetchImpl },
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0].url).toBe("http://127.0.0.1:5500/v1/images/load");
    expect(recorded[0].body).toEqual({
      ref: "vellum-local/assistant:sha-abc",
    });
  });

  test("throws HostImageLoaderError with status when server returns non-2xx", async () => {
    const recorded: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = makeFetch(
      [
        {
          url: "http://127.0.0.1:5500/v1/images/load",
          body: { loaded: false, error: "docker save failed: image not found" },
          status: 502,
        },
      ],
      recorded,
    );

    await expect(
      loadImageViaHost(
        "http://127.0.0.1:5500/v1/images/load",
        "vellum-local/nope:abc",
        silentLog,
        { fetchImpl },
      ),
    ).rejects.toBeInstanceOf(HostImageLoaderError);

    // Re-run to inspect fields (one-shot fetchImpl, so build a new one)
    const recorded2: Array<{ url: string; body: unknown }> = [];
    const fetchImpl2 = makeFetch(
      [
        {
          url: "http://127.0.0.1:5500/v1/images/load",
          body: { loaded: false, error: "docker save failed: image not found" },
          status: 502,
        },
      ],
      recorded2,
    );

    let caught: HostImageLoaderError | null = null;
    try {
      await loadImageViaHost(
        "http://127.0.0.1:5500/v1/images/load",
        "vellum-local/nope:abc",
        silentLog,
        { fetchImpl: fetchImpl2 },
      );
    } catch (err) {
      caught = err as HostImageLoaderError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.status).toBe(502);
    expect(caught?.ref).toBe("vellum-local/nope:abc");
    expect(caught?.message).toContain("502");
    expect(caught?.message).toContain("docker save failed");
  });

  test("provides helpful guidance when the loader is unreachable", async () => {
    const fetchImpl: FetchLike = async () => {
      const err = new TypeError("fetch failed") as TypeError & {
        cause?: { code?: string };
      };
      err.cause = { code: "ECONNREFUSED" };
      throw err;
    };

    let caught: HostImageLoaderError | null = null;
    try {
      await loadImageViaHost(
        "http://127.0.0.1:5500/v1/images/load",
        "vellum-local/anything:xyz",
        silentLog,
        { fetchImpl },
      );
    } catch (err) {
      caught = err as HostImageLoaderError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toContain("loader running");
    expect(caught?.message).toContain("VELLUM_ASSISTANT_IMAGE");
  });

  test("wraps generic fetch errors", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ETIMEDOUT");
    };

    let caught: HostImageLoaderError | null = null;
    try {
      await loadImageViaHost(
        "http://127.0.0.1:5500/v1/images/load",
        "x",
        silentLog,
        { fetchImpl },
      );
    } catch (err) {
      caught = err as HostImageLoaderError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toContain("ETIMEDOUT");
  });

  test("handles non-JSON error bodies", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("<html>500 internal</html>", {
        status: 500,
        headers: { "Content-Type": "text/html" },
      });

    let caught: HostImageLoaderError | null = null;
    try {
      await loadImageViaHost(
        "http://127.0.0.1:5500/v1/images/load",
        "x",
        silentLog,
        { fetchImpl },
      );
    } catch (err) {
      caught = err as HostImageLoaderError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.status).toBe(500);
    expect(caught?.message).toContain("HTTP 500");
  });
});
