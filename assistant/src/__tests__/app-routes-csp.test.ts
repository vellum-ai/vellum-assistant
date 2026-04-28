import { describe, expect, mock, test } from "bun:test";

// Mock the logger before importing the module under test
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Fake app records keyed by ID
const legacyApp = {
  id: "legacy-1",
  name: "Legacy App",
  htmlDefinition: "<div>Hello</div>",
  schemaJson: "{}",
  createdAt: 0,
  updatedAt: 0,
  // No formatVersion → legacy
};

const multifileApp = {
  id: "multi-1",
  name: "Multifile App",
  htmlDefinition: "",
  schemaJson: "{}",
  createdAt: 0,
  updatedAt: 0,
  formatVersion: 2,
};

const apps = new Map<string, typeof legacyApp | typeof multifileApp>([
  ["legacy-1", legacyApp],
  ["multi-1", multifileApp],
]);

mock.module("../memory/app-store.js", () => ({
  getApp: (id: string) => apps.get(id) ?? null,
  getAppsDir: () => "/fake/apps",
  getAppDirPath: (appId: string) => `/fake/apps/${appId}`,
  isMultifileApp: (app: Record<string, unknown>) => app.formatVersion === 2,
}));

// Mock shared-app-links-store (imported by app-routes but unused here)
mock.module("../memory/shared-app-links-store.js", () => ({
  createSharedAppLink: () => ({ shareToken: "tok" }),
  getSharedAppLink: () => null,
  incrementDownloadCount: () => {},
  deleteSharedAppLinkByToken: () => false,
}));

// Stub fs so the multifile path finds a fake dist/index.html
mock.module("node:fs", () => ({
  existsSync: (p: string) => p === "/fake/apps/multi-1/dist/index.html",
  readFileSync: (p: string, _enc?: string) => {
    if (p === "/fake/apps/multi-1/dist/index.html") {
      return '<!DOCTYPE html><html><head></head><body><script src="main.js"></script></body></html>';
    }
    // Design system CSS — return empty string
    return "";
  },
}));

import { ROUTES } from "../runtime/routes/app-routes.js";
import { BadRequestError, NotFoundError } from "../runtime/routes/errors.js";
import type { ResponseHeaderArgs } from "../runtime/routes/types.js";

/** Find a route by operationId. */
function getRoute(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route not found: ${operationId}`);
  return route;
}

/** Resolve responseHeaders from a route definition for the given args. */
function getResponseHeaders(
  operationId: string,
  args: ResponseHeaderArgs,
): Record<string, string> {
  const route = getRoute(operationId);
  if (!route.responseHeaders) return {};
  if (typeof route.responseHeaders === "function") {
    return route.responseHeaders(args);
  }
  return route.responseHeaders;
}

/** Parse CSP header into a directive map. */
function parseCsp(header: string): Record<string, string> {
  const directives: Record<string, string> = {};
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) continue;
    directives[trimmed.slice(0, spaceIdx)] = trimmed.slice(spaceIdx + 1);
  }
  return directives;
}

describe("app-routes CSP headers", () => {
  describe("legacy apps", () => {
    test("includes 'unsafe-inline' in script-src", () => {
      const headers = getResponseHeaders("pages_serve", {
        pathParams: { appId: "legacy-1" },
      });
      const directives = parseCsp(headers["Content-Security-Policy"]);
      expect(directives["script-src"]).toContain("'unsafe-inline'");
    });

    test("includes 'unsafe-inline' in style-src", () => {
      const headers = getResponseHeaders("pages_serve", {
        pathParams: { appId: "legacy-1" },
      });
      const directives = parseCsp(headers["Content-Security-Policy"]);
      expect(directives["style-src"]).toContain("'unsafe-inline'");
    });

    test("has img-src with self, data, and https", () => {
      const headers = getResponseHeaders("pages_serve", {
        pathParams: { appId: "legacy-1" },
      });
      const directives = parseCsp(headers["Content-Security-Policy"]);
      expect(directives["img-src"]).toContain("'self'");
      expect(directives["img-src"]).toContain("data:");
      expect(directives["img-src"]).toContain("https:");
    });
  });

  describe("multifile apps", () => {
    test("does NOT include 'unsafe-inline' in script-src", () => {
      const headers = getResponseHeaders("pages_serve", {
        pathParams: { appId: "multi-1" },
      });
      const directives = parseCsp(headers["Content-Security-Policy"]);
      expect(directives["script-src"]).not.toContain("'unsafe-inline'");
    });

    test("includes 'self' in script-src for external main.js", () => {
      const headers = getResponseHeaders("pages_serve", {
        pathParams: { appId: "multi-1" },
      });
      const directives = parseCsp(headers["Content-Security-Policy"]);
      expect(directives["script-src"]).toContain("'self'");
    });

    test("includes 'unsafe-inline' in style-src", () => {
      const headers = getResponseHeaders("pages_serve", {
        pathParams: { appId: "multi-1" },
      });
      const directives = parseCsp(headers["Content-Security-Policy"]);
      expect(directives["style-src"]).toContain("'unsafe-inline'");
    });

    test("has img-src with self, data, and https", () => {
      const headers = getResponseHeaders("pages_serve", {
        pathParams: { appId: "multi-1" },
      });
      const directives = parseCsp(headers["Content-Security-Policy"]);
      expect(directives["img-src"]).toContain("'self'");
      expect(directives["img-src"]).toContain("data:");
      expect(directives["img-src"]).toContain("https:");
    });
  });

  describe("handleServeDistFile appId validation", () => {
    const distHandler = getRoute("apps_dist_file").handler;

    test("rejects appId with encoded path traversal (..)", () => {
      expect(() =>
        distHandler({ pathParams: { appId: "..", filename: "main.js" } }),
      ).toThrow(BadRequestError);
    });

    test("rejects appId with forward slash", () => {
      expect(() =>
        distHandler({
          pathParams: { appId: "../../etc", filename: "main.js" },
        }),
      ).toThrow(BadRequestError);
    });

    test("rejects appId with backslash", () => {
      expect(() =>
        distHandler({
          pathParams: { appId: "foo\\bar", filename: "main.js" },
        }),
      ).toThrow(BadRequestError);
    });

    test("rejects empty appId", () => {
      expect(() =>
        distHandler({ pathParams: { appId: "", filename: "main.js" } }),
      ).toThrow(BadRequestError);
    });

    test("rejects appId with leading whitespace", () => {
      expect(() =>
        distHandler({
          pathParams: { appId: " multi-1", filename: "main.js" },
        }),
      ).toThrow(BadRequestError);
    });

    test("rejects appId with trailing whitespace", () => {
      expect(() =>
        distHandler({
          pathParams: { appId: "multi-1 ", filename: "main.js" },
        }),
      ).toThrow(BadRequestError);
    });

    test("rejects appId containing .. in the middle", () => {
      expect(() =>
        distHandler({
          pathParams: { appId: "foo..bar", filename: "main.js" },
        }),
      ).toThrow(BadRequestError);
    });

    test("allows valid appId and filename (file not found throws NotFoundError)", () => {
      expect(() =>
        distHandler({
          pathParams: { appId: "multi-1", filename: "main.js" },
        }),
      ).toThrow(NotFoundError);
    });
  });

  describe("consistent directives across formats", () => {
    test("both formats share the same style-src policy", () => {
      const legacyHeaders = getResponseHeaders("pages_serve", {
        pathParams: { appId: "legacy-1" },
      });
      const multiHeaders = getResponseHeaders("pages_serve", {
        pathParams: { appId: "multi-1" },
      });
      const legacyCsp = parseCsp(legacyHeaders["Content-Security-Policy"]);
      const multiCsp = parseCsp(multiHeaders["Content-Security-Policy"]);
      expect(legacyCsp["style-src"]).toBe(multiCsp["style-src"]);
    });

    test("both formats share the same img-src policy", () => {
      const legacyHeaders = getResponseHeaders("pages_serve", {
        pathParams: { appId: "legacy-1" },
      });
      const multiHeaders = getResponseHeaders("pages_serve", {
        pathParams: { appId: "multi-1" },
      });
      const legacyCsp = parseCsp(legacyHeaders["Content-Security-Policy"]);
      const multiCsp = parseCsp(multiHeaders["Content-Security-Policy"]);
      expect(legacyCsp["img-src"]).toBe(multiCsp["img-src"]);
    });
  });
});
