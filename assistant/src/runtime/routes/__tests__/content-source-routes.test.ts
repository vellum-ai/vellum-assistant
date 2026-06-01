/**
 * Unit tests for content-source-routes.ts.
 *
 * Drives the handler function directly (bypassing the router) and mocks
 * out node:fs writes so no real I/O occurs.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — must appear before any imports of the module under test
// ---------------------------------------------------------------------------

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const FAKE_WORKSPACE = "/tmp/content-source-routes-test-workspace";

mock.module("../../../util/platform.js", () => ({
  getWorkspaceDir: () => FAKE_WORKSPACE,
}));

const writtenFiles = new Map<string, string>();

mock.module("node:fs", () => ({
  mkdirSync: () => {},
  writeFileSync: (path: string, content: string) => {
    writtenFiles.set(path, content);
  },
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { ROUTES } from "../content-source-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

afterAll(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

function makeArgs(body?: Record<string, unknown>): RouteHandlerArgs {
  return { body };
}

const handler = findHandler("content_source_set");

beforeEach(() => {
  writtenFiles.clear();
});

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

describe("content_source_set — URL validation", () => {
  test("https URL is accepted and sidecar written", () => {
    const result = handler(makeArgs({ url: "https://myblog.com/posts" }));
    expect(result).toEqual({ ok: true });

    const expectedPath = `${FAKE_WORKSPACE}/data/content-source.json`;
    expect(writtenFiles.has(expectedPath)).toBe(true);
    const written = JSON.parse(writtenFiles.get(expectedPath)!);
    expect(written.url).toBe("https://myblog.com/posts");
  });

  test("http URL is accepted and sidecar written", () => {
    const result = handler(makeArgs({ url: "http://intranet.example.com" }));
    expect(result).toEqual({ ok: true });
  });

  test("URL with leading/trailing whitespace is trimmed", () => {
    const result = handler(makeArgs({ url: "  https://blog.example.com  " }));
    expect(result).toEqual({ ok: true });

    const expectedPath = `${FAKE_WORKSPACE}/data/content-source.json`;
    const written = JSON.parse(writtenFiles.get(expectedPath)!);
    expect(written.url).toBe("https://blog.example.com/");
  });

  test("bare hostname without protocol returns invalid_url", () => {
    const result = handler(makeArgs({ url: "myblog.com" }));
    expect(result).toEqual({ ok: false, error: "invalid_url" });
    expect(writtenFiles.size).toBe(0);
  });

  test("ftp:// URL is rejected", () => {
    const result = handler(makeArgs({ url: "ftp://files.example.com" }));
    expect(result).toEqual({ ok: false, error: "invalid_url" });
    expect(writtenFiles.size).toBe(0);
  });

  test("empty string returns invalid_url", () => {
    const result = handler(makeArgs({ url: "" }));
    expect(result).toEqual({ ok: false, error: "invalid_url" });
    expect(writtenFiles.size).toBe(0);
  });

  test("whitespace-only string returns invalid_url", () => {
    const result = handler(makeArgs({ url: "   " }));
    expect(result).toEqual({ ok: false, error: "invalid_url" });
    expect(writtenFiles.size).toBe(0);
  });

  test("javascript: URL is rejected", () => {
    const result = handler(makeArgs({ url: "javascript:alert(1)" }));
    expect(result).toEqual({ ok: false, error: "invalid_url" });
    expect(writtenFiles.size).toBe(0);
  });

  test("missing url field returns invalid_url", () => {
    const result = handler(makeArgs({}));
    expect(result).toEqual({ ok: false, error: "invalid_url" });
  });
});

// ---------------------------------------------------------------------------
// Sidecar content verification
// ---------------------------------------------------------------------------

describe("content_source_set — sidecar contents", () => {
  test("writes url to data/content-source.json", () => {
    handler(makeArgs({ url: "https://example.com/blog" }));

    const expectedPath = `${FAKE_WORKSPACE}/data/content-source.json`;
    expect(writtenFiles.has(expectedPath)).toBe(true);

    const written = JSON.parse(writtenFiles.get(expectedPath)!);
    expect(Object.keys(written)).toEqual(["url"]);
  });

  test("no sidecar written on invalid URL", () => {
    handler(makeArgs({ url: "not-a-url" }));
    expect(writtenFiles.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Route policy verification
// ---------------------------------------------------------------------------

describe("route policy", () => {
  test("content_source_set requires settings.write (secrets-grade)", () => {
    const route = ROUTES.find((r) => r.operationId === "content_source_set");
    expect(route?.policy?.requiredScopes).toContain("settings.write");
  });
});
