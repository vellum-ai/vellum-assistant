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
  getAppDirPath: (id: string) => `/fake/apps/${id}`,
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

import {
  handleServeDistFile,
  handleServePage,
} from "../runtime/routes/app-routes.js";

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
      const res = handleServePage("legacy-1");
      const csp = res.headers.get("Content-Security-Policy")!;
      const directives = parseCsp(csp);
      expect(directives["script-src"]).toContain("'unsafe-inline'");
    });

    test("includes 'unsafe-inline' in style-src", () => {
      const res = handleServePage("legacy-1");
      const csp = res.headers.get("Content-Security-Policy")!;
      const directives = parseCsp(csp);
      expect(directives["style-src"]).toContain("'unsafe-inline'");
    });

    test("has img-src with self, data, and https", () => {
      const res = handleServePage("legacy-1");
      const csp = res.headers.get("Content-Security-Policy")!;
      const directives = parseCsp(csp);
      expect(directives["img-src"]).toContain("'self'");
      expect(directives["img-src"]).toContain("data:");
      expect(directives["img-src"]).toContain("https:");
    });
  });

  describe("multifile apps", () => {
    test("does NOT include 'unsafe-inline' in script-src", () => {
      const res = handleServePage("multi-1");
      const csp = res.headers.get("Content-Security-Policy")!;
      const directives = parseCsp(csp);
      expect(directives["script-src"]).not.toContain("'unsafe-inline'");
    });

    test("includes 'self' in script-src for external main.js", () => {
      const res = handleServePage("multi-1");
      const csp = res.headers.get("Content-Security-Policy")!;
      const directives = parseCsp(csp);
      expect(directives["script-src"]).toContain("'self'");
    });

    test("includes 'unsafe-inline' in style-src", () => {
      const res = handleServePage("multi-1");
      const csp = res.headers.get("Content-Security-Policy")!;
      const directives = parseCsp(csp);
      expect(directives["style-src"]).toContain("'unsafe-inline'");
    });

    test("has img-src with self, data, and https", () => {
      const res = handleServePage("multi-1");
      const csp = res.headers.get("Content-Security-Policy")!;
      const directives = parseCsp(csp);
      expect(directives["img-src"]).toContain("'self'");
      expect(directives["img-src"]).toContain("data:");
      expect(directives["img-src"]).toContain("https:");
    });
  });

  describe("handleServeDistFile appId validation", () => {
    test("rejects appId with encoded path traversal (..)", () => {
      const res = handleServeDistFile("..", "main.js");
      expect(res.status).toBe(400);
    });

    test("rejects appId with forward slash", () => {
      const res = handleServeDistFile("../../etc", "main.js");
      expect(res.status).toBe(400);
    });

    test("rejects appId with backslash", () => {
      const res = handleServeDistFile("foo\\bar", "main.js");
      expect(res.status).toBe(400);
    });

    test("rejects empty appId", () => {
      const res = handleServeDistFile("", "main.js");
      expect(res.status).toBe(400);
    });

    test("rejects appId with leading whitespace", () => {
      const res = handleServeDistFile(" multi-1", "main.js");
      expect(res.status).toBe(400);
    });

    test("rejects appId with trailing whitespace", () => {
      const res = handleServeDistFile("multi-1 ", "main.js");
      expect(res.status).toBe(400);
    });

    test("rejects appId containing .. in the middle", () => {
      const res = handleServeDistFile("foo..bar", "main.js");
      expect(res.status).toBe(400);
    });

    test("allows valid appId and filename (file not found is 404)", () => {
      const res = handleServeDistFile("multi-1", "main.js");
      // File doesn't exist in our mock fs, so 404
      expect(res.status).toBe(404);
    });
  });

  describe("consistent directives across formats", () => {
    test("both formats share the same style-src policy", () => {
      const legacy = handleServePage("legacy-1");
      const multi = handleServePage("multi-1");
      const legacyCsp = parseCsp(
        legacy.headers.get("Content-Security-Policy")!,
      );
      const multiCsp = parseCsp(multi.headers.get("Content-Security-Policy")!);
      expect(legacyCsp["style-src"]).toBe(multiCsp["style-src"]);
    });

    test("both formats share the same img-src policy", () => {
      const legacy = handleServePage("legacy-1");
      const multi = handleServePage("multi-1");
      const legacyCsp = parseCsp(
        legacy.headers.get("Content-Security-Policy")!,
      );
      const multiCsp = parseCsp(multi.headers.get("Content-Security-Policy")!);
      expect(legacyCsp["img-src"]).toBe(multiCsp["img-src"]);
    });
  });
});
