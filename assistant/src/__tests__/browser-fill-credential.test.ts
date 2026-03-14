import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../util/platform.js", () => ({
  getDataDir: () => "/tmp/browser-fill-credential-test",
}));

let mockPage: {
  click: ReturnType<typeof mock>;
  fill: ReturnType<typeof mock>;
  press: ReturnType<typeof mock>;
  evaluate: ReturnType<typeof mock>;
  title: ReturnType<typeof mock>;
  url: ReturnType<typeof mock>;
  goto: ReturnType<typeof mock>;
  close: () => Promise<void>;
  isClosed: () => boolean;
};

let snapshotMaps: Map<string, Map<string, string>>;

mock.module("../tools/browser/browser-manager.js", () => {
  snapshotMaps = new Map();
  return {
    browserManager: {
      getOrCreateSessionPage: async () => mockPage,
      closeSessionPage: async () => {},
      closeAllPages: async () => {},
      storeSnapshotMap: (sessionId: string, map: Map<string, string>) => {
        snapshotMaps.set(sessionId, map);
      },
      resolveSnapshotSelector: (sessionId: string, elementId: string) => {
        const map = snapshotMaps.get(sessionId);
        if (!map) return null;
        return map.get(elementId) ?? null;
      },
    },
  };
});

mock.module("../tools/network/url-safety.js", () => ({
  parseUrl: () => null,
  isPrivateOrLocalHost: () => false,
  resolveHostAddresses: async () => [],
  resolveRequestAddress: async () => ({}),
  sanitizeUrlForOutput: (url: URL) => url.href,
}));

let mockGetSecureKey: ReturnType<typeof mock>;
let mockGetCredentialMetadata: ReturnType<typeof mock>;

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (...args: unknown[]) => mockGetSecureKey(...args),
  getSecureKeyAsync: async (...args: unknown[]) => mockGetSecureKey(...args),
  setSecureKey: () => true,
  setSecureKeyAsync: async () => true,
  deleteSecureKey: () => "deleted",
  deleteSecureKeyAsync: async () => "deleted",
  listSecureKeys: () => [],
  getBackendType: () => "encrypted",
  _resetBackend: () => {},
  _setBackend: () => {},
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  getCredentialMetadata: (...args: unknown[]) =>
    mockGetCredentialMetadata(...args),
  getCredentialMetadataById: () => undefined,
  upsertCredentialMetadata: () => {},
  deleteCredentialMetadata: () => {},
  _setMetadataPath: () => {},
}));

import { credentialKey } from "../security/credential-key.js";
import { executeBrowserFillCredential } from "../tools/browser/browser-execution.js";
import type { ToolContext } from "../tools/types.js";

const ctx: ToolContext = {
  sessionId: "test-session",
  conversationId: "test-conversation",
  workingDir: "/tmp",
  trustClass: "guardian",
};

function resetMockPage() {
  mockPage = {
    click: mock(async () => {}),
    fill: mock(async () => {}),
    press: mock(async () => {}),
    evaluate: mock(async () => ""),
    title: mock(async () => "Test Page"),
    url: mock(() => "https://example.com/"),
    goto: mock(async () => ({
      status: () => 200,
      url: () => "https://example.com/",
    })),
    close: async () => {},
    isClosed: () => false,
  };
}

function defaultMetadata(service: string, field: string) {
  return {
    credentialId: `${service}:${field}`,
    service,
    field,
    allowedTools: ["browser_fill_credential"],
    allowedDomains: [] as string[],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ── browser_fill_credential ──────────────────────────────────────────

describe("executeBrowserFillCredential", () => {
  beforeEach(() => {
    resetMockPage();
    snapshotMaps.clear();
    mockGetSecureKey = mock(() => "super-secret-password");
    mockGetCredentialMetadata = mock((service: string, field: string) =>
      defaultMetadata(service, field),
    );
  });

  test("fills credential into element by element_id", async () => {
    snapshotMaps.set(
      "test-session",
      new Map([["e1", '[data-vellum-eid="e1"]']]),
    );
    const result = await executeBrowserFillCredential(
      { service: "gmail", field: "password", element_id: "e1" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Filled password for gmail");
    expect(mockPage.fill).toHaveBeenCalledWith(
      '[data-vellum-eid="e1"]',
      "super-secret-password",
    );
    expect(mockGetSecureKey).toHaveBeenCalledWith(
      credentialKey("gmail", "password"),
    );
  });

  test("fills credential by CSS selector", async () => {
    const result = await executeBrowserFillCredential(
      { service: "github", field: "token", selector: 'input[name="password"]' },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Filled token for github");
    expect(mockPage.fill).toHaveBeenCalledWith(
      'input[name="password"]',
      "super-secret-password",
    );
  });

  test("returns error when credential not found", async () => {
    mockGetCredentialMetadata = mock(() => undefined);
    snapshotMaps.set(
      "test-session",
      new Map([["e1", '[data-vellum-eid="e1"]']]),
    );
    const result = await executeBrowserFillCredential(
      { service: "slack", field: "api_key", element_id: "e1" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No credential stored for slack/api_key");
    expect(result.content).toContain("credential_store");
    expect(mockPage.fill).not.toHaveBeenCalled();
  });

  test("returns error when metadata exists but no stored value", async () => {
    mockGetSecureKey = mock(() => undefined);
    snapshotMaps.set(
      "test-session",
      new Map([["e1", '[data-vellum-eid="e1"]']]),
    );
    const result = await executeBrowserFillCredential(
      { service: "slack", field: "api_key", element_id: "e1" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No credential stored for slack/api_key");
    expect(result.content).toContain("credential_store");
    expect(mockPage.fill).not.toHaveBeenCalled();
  });

  test("returns error when element not found", async () => {
    const result = await executeBrowserFillCredential(
      { service: "gmail", field: "password", element_id: "e99" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('element_id "e99" not found');
    expect(result.content).toContain("browser_snapshot");
  });

  test("presses Enter after fill when press_enter is true", async () => {
    snapshotMaps.set(
      "test-session",
      new Map([["e2", '[data-vellum-eid="e2"]']]),
    );
    const result = await executeBrowserFillCredential(
      {
        service: "gmail",
        field: "password",
        element_id: "e2",
        press_enter: true,
      },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(mockPage.fill).toHaveBeenCalledWith(
      '[data-vellum-eid="e2"]',
      "super-secret-password",
    );
    expect(mockPage.press).toHaveBeenCalledWith(
      '[data-vellum-eid="e2"]',
      "Enter",
    );
  });

  test("credential value NEVER appears in result content", async () => {
    snapshotMaps.set(
      "test-session",
      new Map([["e1", '[data-vellum-eid="e1"]']]),
    );
    const result = await executeBrowserFillCredential(
      { service: "gmail", field: "password", element_id: "e1" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("super-secret-password");
  });

  test("returns error when service is missing", async () => {
    snapshotMaps.set(
      "test-session",
      new Map([["e1", '[data-vellum-eid="e1"]']]),
    );
    const result = await executeBrowserFillCredential(
      { field: "password", element_id: "e1" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("service is required");
  });

  test("returns error when field is missing", async () => {
    snapshotMaps.set(
      "test-session",
      new Map([["e1", '[data-vellum-eid="e1"]']]),
    );
    const result = await executeBrowserFillCredential(
      { service: "gmail", element_id: "e1" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("field is required");
  });

  // -----------------------------------------------------------------------
  // Broker-mediated credential access — verify broker path is used
  // -----------------------------------------------------------------------
  describe("broker integration", () => {
    test("fill succeeds with no domain or tool-policy checks", async () => {
      snapshotMaps.set(
        "test-session",
        new Map([["e1", '[data-vellum-eid="e1"]']]),
      );
      const result = await executeBrowserFillCredential(
        { service: "gmail", field: "password", element_id: "e1" },
        ctx,
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Filled password for gmail");
      expect(result.content).not.toContain("super-secret-password");
    });

    test("credential access goes through broker (metadata + value checked)", async () => {
      snapshotMaps.set(
        "test-session",
        new Map([["e1", '[data-vellum-eid="e1"]']]),
      );
      await executeBrowserFillCredential(
        { service: "gmail", field: "password", element_id: "e1" },
        ctx,
      );
      // Broker checks metadata first, then reads the value
      expect(mockGetCredentialMetadata).toHaveBeenCalledWith(
        "gmail",
        "password",
      );
      expect(mockGetSecureKey).toHaveBeenCalledWith(
        credentialKey("gmail", "password"),
      );
    });

    test("returns tool policy denial with actionable message", async () => {
      mockGetCredentialMetadata = mock((service: string, field: string) => ({
        ...defaultMetadata(service, field),
        allowedTools: ["some_other_tool"],
      }));
      snapshotMaps.set(
        "test-session",
        new Map([["e1", '[data-vellum-eid="e1"]']]),
      );
      const result = await executeBrowserFillCredential(
        { service: "gmail", field: "password", element_id: "e1" },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Policy denied");
      expect(result.content).toContain("not allowed to use credential");
      expect(result.content).toContain("credential_store");
      expect(mockPage.fill).not.toHaveBeenCalled();
    });

    test("returns domain policy denial with actionable message", async () => {
      mockGetCredentialMetadata = mock((service: string, field: string) => ({
        ...defaultMetadata(service, field),
        allowedDomains: ["other-site.com"],
      }));
      snapshotMaps.set(
        "test-session",
        new Map([["e1", '[data-vellum-eid="e1"]']]),
      );
      const result = await executeBrowserFillCredential(
        { service: "gmail", field: "password", element_id: "e1" },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Domain policy denied");
      expect(result.content).toContain("Navigate to an allowed domain");
      expect(mockPage.fill).not.toHaveBeenCalled();
    });

    test("passes current page domain to broker", async () => {
      mockGetCredentialMetadata = mock((service: string, field: string) => ({
        ...defaultMetadata(service, field),
        allowedDomains: ["example.com"],
      }));
      snapshotMaps.set(
        "test-session",
        new Map([["e1", '[data-vellum-eid="e1"]']]),
      );
      const result = await executeBrowserFillCredential(
        { service: "gmail", field: "password", element_id: "e1" },
        ctx,
      );
      // Page URL is https://example.com/ which matches allowedDomains
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Filled password for gmail");
    });

    test("policy denial errors never contain credential values", async () => {
      mockGetCredentialMetadata = mock((service: string, field: string) => ({
        ...defaultMetadata(service, field),
        allowedTools: ["other_tool"],
      }));
      snapshotMaps.set(
        "test-session",
        new Map([["e1", '[data-vellum-eid="e1"]']]),
      );
      const result = await executeBrowserFillCredential(
        { service: "gmail", field: "password", element_id: "e1" },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content).not.toContain("super-secret-password");
    });
  });
});
