import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

/**
 * Fake CDP session driven by the real `LocalCdpClient` via the mocked
 * `browserManager.getOrCreateSessionPage` below. `sendCalls` records
 * every `session.send(method, params)` so tests can assert the exact
 * sequence of CDP commands issued by `executeBrowserFillCredential`.
 * `sendHandler` is replaced per test to shape responses or throw.
 */
interface SendCall {
  method: string;
  params: Record<string, unknown> | undefined;
}

let sendCalls: SendCall[];
let sendHandler: (
  method: string,
  params: Record<string, unknown> | undefined,
) => unknown;
let detachCalls: number;

function resetCdpMock() {
  sendCalls = [];
  detachCalls = 0;
  sendHandler = defaultCdpHandler;
}

const fakeCdpSession = {
  send: async (method: string, params?: Record<string, unknown>) => {
    sendCalls.push({ method, params });
    const value = sendHandler(method, params);
    if (value instanceof Error) throw value;
    return value;
  },
  detach: async () => {
    detachCalls += 1;
  },
};

/**
 * Fake Playwright page that LocalCdpClient drives. Only the
 * `context().newCDPSession()` surface is needed — all credential-fill
 * work now flows through CDP.
 */
let mockPage: {
  close: () => Promise<void>;
  isClosed: () => boolean;
  context: () => {
    newCDPSession: (page: unknown) => Promise<typeof fakeCdpSession>;
  };
};

let snapshotBackendNodeMaps: Map<string, Map<string, number>>;

const preferredBackendKinds = new Map<string, string>();

mock.module("../tools/browser/browser-manager.js", () => {
  snapshotBackendNodeMaps = new Map();
  preferredBackendKinds.clear();
  return {
    browserManager: {
      getOrCreateSessionPage: async () => mockPage,
      closeSessionPage: async () => {},
      closeAllPages: async () => {},
      storeSnapshotBackendNodeMap: (
        conversationId: string,
        map: Map<string, number>,
      ) => {
        snapshotBackendNodeMaps.set(conversationId, map);
      },
      resolveSnapshotBackendNodeId: (
        conversationId: string,
        elementId: string,
      ) => {
        const map = snapshotBackendNodeMaps.get(conversationId);
        if (!map) return null;
        return map.get(elementId) ?? null;
      },
      clearSnapshotBackendNodeMap: (conversationId: string) => {
        snapshotBackendNodeMaps.delete(conversationId);
      },
      getPreferredBackendKind: (conversationId: string) =>
        preferredBackendKinds.get(conversationId) ?? null,
      setPreferredBackendKind: (conversationId: string, kind: string) => {
        preferredBackendKinds.set(conversationId, kind);
      },
      clearPreferredBackendKind: (conversationId: string) => {
        preferredBackendKinds.delete(conversationId);
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
  getSecureKeyAsync: async (...args: unknown[]) => mockGetSecureKey(...args),
  setSecureKeyAsync: async () => true,
  deleteSecureKeyAsync: async () => "deleted",
  listSecureKeysAsync: async () => ({ accounts: [], unreachable: false }),
  _resetBackend: () => {},
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
  conversationId: "test-conversation",
  workingDir: "/tmp",
  trustClass: "guardian",
};

function resetMockPage() {
  mockPage = {
    close: async () => {},
    isClosed: () => false,
    context: () => ({
      newCDPSession: async (_page: unknown) => fakeCdpSession,
    }),
  };
}

/**
 * Default CDP handler used by every test unless overridden. Returns
 * the minimum plumbing needed for:
 *   - `getCurrentUrl` via Runtime.evaluate (for the broker domain check)
 *   - `querySelectorBackendNodeId` via DOM.getDocument / querySelector / describeNode
 *   - `focusElement` via DOM.focus
 *   - `clearAndInsertText` via DOM.resolveNode + Runtime.callFunctionOn + Input.insertText
 *   - `dispatchKeyPress` via Input.dispatchKeyEvent
 */
function defaultCdpHandler(
  method: string,
  _params: Record<string, unknown> | undefined,
): unknown {
  switch (method) {
    case "Runtime.evaluate":
      // getCurrentUrl() reads document.location.href via Runtime.evaluate
      return { result: { value: "https://example.com/" } };
    case "DOM.getDocument":
      return { root: { nodeId: 1 } };
    case "DOM.querySelector":
      return { nodeId: 42 };
    case "DOM.describeNode":
      return { node: { backendNodeId: 100 } };
    case "DOM.resolveNode":
      // Used by clearAndInsertText to obtain a remote object on the
      // target element so it can run the value-clearing function.
      return { object: { objectId: "obj-1" } };
    case "Runtime.callFunctionOn":
      // The clear-helper function returns undefined; tests don't
      // depend on the return value.
      return { result: { value: undefined } };
    default:
      return {};
  }
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
    resetCdpMock();
    snapshotBackendNodeMaps.clear();
    mockGetSecureKey = mock(() => "super-secret-password");
    mockGetCredentialMetadata = mock((service: string, field: string) =>
      defaultMetadata(service, field),
    );
  });

  test("fills credential into element by element_id", async () => {
    snapshotBackendNodeMaps.set("test-conversation", new Map([["e1", 555]]));
    const result = await executeBrowserFillCredential(
      { service: "gmail", field: "password", element_id: "e1" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Filled password for gmail");

    // Backend path now goes through clearAndInsertText:
    //   Runtime.evaluate (getCurrentUrl)
    //   → DOM.focus
    //   → DOM.resolveNode
    //   → Runtime.callFunctionOn (clear)
    //   → DOM.focus (re-focus)
    //   → Input.insertText
    const methods = sendCalls.map((c) => c.method);
    expect(methods).toContain("DOM.focus");
    expect(methods).toContain("DOM.resolveNode");
    expect(methods).toContain("Runtime.callFunctionOn");
    expect(methods).toContain("Input.insertText");
    expect(methods).not.toContain("DOM.querySelector");

    const focusCall = sendCalls.find((c) => c.method === "DOM.focus")!;
    expect(focusCall.params).toEqual({ backendNodeId: 555 });

    const insertCall = sendCalls.find((c) => c.method === "Input.insertText")!;
    expect(insertCall.params).toEqual({ text: "super-secret-password" });

    expect(mockGetSecureKey).toHaveBeenCalledWith(
      credentialKey("gmail", "password"),
    );

    // CdpClient disposed in finally → session.detach called.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(detachCalls).toBe(1);
  });

  test("clears pre-populated field BEFORE inserting credential text", async () => {
    // Regression: previously, fillCredential called focus + insertText
    // directly, which APPENDED the credential to any existing value
    // (autofill, prior typing, etc.) — corrupting the password and
    // leaking partial state. The fix routes through the shared
    // clearAndInsertText helper.
    snapshotBackendNodeMaps.set("test-conversation", new Map([["e1", 555]]));
    await executeBrowserFillCredential(
      { service: "gmail", field: "password", element_id: "e1" },
      ctx,
    );

    // The clear must happen BEFORE the insertText. Specifically, the
    // Runtime.callFunctionOn that runs the clearing function declaration
    // must precede Input.insertText.
    const methodSeq = sendCalls.map((c) => c.method);
    const clearIdx = methodSeq.indexOf("Runtime.callFunctionOn");
    const insertIdx = methodSeq.indexOf("Input.insertText");
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(clearIdx);

    // The clearing function must reset both `value` and
    // `textContent` so input/textarea AND contenteditable targets
    // are handled.
    const clearCall = sendCalls[clearIdx]!;
    const fnDecl = (clearCall.params as { functionDeclaration: string })
      .functionDeclaration;
    expect(fnDecl).toContain('this.value = ""');
    expect(fnDecl).toContain("this.textContent");
    expect(fnDecl).toContain('new Event("input"');

    // After the clear, the helper re-focuses the element (some sites
    // blur on programmatic value reset) before inserting text — so we
    // expect at least 2 DOM.focus calls in total.
    const focusCount = methodSeq.filter((m) => m === "DOM.focus").length;
    expect(focusCount).toBeGreaterThanOrEqual(2);
  });

  test("fills credential by CSS selector", async () => {
    const result = await executeBrowserFillCredential(
      { service: "github", field: "token", selector: 'input[name="password"]' },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Filled token for github");

    // Selector path must resolve the backendNodeId via DOM.querySelector
    // before focusing + inserting text.
    const methods = sendCalls.map((c) => c.method);
    expect(methods).toContain("DOM.getDocument");
    expect(methods).toContain("DOM.querySelector");
    expect(methods).toContain("DOM.describeNode");
    expect(methods).toContain("DOM.focus");
    expect(methods).toContain("Input.insertText");

    // DOM.focus uses the backendNodeId (100) returned by DOM.describeNode
    const focusCall = sendCalls.find((c) => c.method === "DOM.focus")!;
    expect(focusCall.params).toEqual({ backendNodeId: 100 });

    const insertCall = sendCalls.find((c) => c.method === "Input.insertText")!;
    expect(insertCall.params).toEqual({ text: "super-secret-password" });
  });

  test("returns error when credential not found", async () => {
    mockGetCredentialMetadata = mock(() => undefined);
    snapshotBackendNodeMaps.set("test-conversation", new Map([["e1", 555]]));
    const result = await executeBrowserFillCredential(
      { service: "slack", field: "api_key", element_id: "e1" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No credential stored for slack/api_key");
    expect(result.content).toContain("credential_store");
    // The broker short-circuits before DOM.focus is dispatched.
    const methods = sendCalls.map((c) => c.method);
    expect(methods).not.toContain("DOM.focus");
    expect(methods).not.toContain("Input.insertText");
  });

  test("returns error when metadata exists but no stored value", async () => {
    mockGetSecureKey = mock(() => undefined);
    snapshotBackendNodeMaps.set("test-conversation", new Map([["e1", 555]]));
    const result = await executeBrowserFillCredential(
      { service: "slack", field: "api_key", element_id: "e1" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No credential stored for slack/api_key");
    expect(result.content).toContain("credential_store");
    const methods = sendCalls.map((c) => c.method);
    expect(methods).not.toContain("Input.insertText");
  });

  test("returns error when element not found", async () => {
    const result = await executeBrowserFillCredential(
      { service: "gmail", field: "password", element_id: "e99" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('element_id "e99" not found');
    expect(result.content).toContain("snapshot");
    // Element resolution fails before any CDP session is opened.
    expect(sendCalls).toHaveLength(0);
    expect(detachCalls).toBe(0);
  });

  test("presses Enter after fill when press_enter is true", async () => {
    snapshotBackendNodeMaps.set("test-conversation", new Map([["e2", 222]]));
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
    const methods = sendCalls.map((c) => c.method);
    expect(methods).toContain("Input.insertText");
    // dispatchKeyPress for "Enter" dispatches keyDown + char + keyUp
    // (Enter has text "\r" so it now produces a char event too).
    const keyEvents = sendCalls.filter(
      (c) => c.method === "Input.dispatchKeyEvent",
    );
    expect(keyEvents).toHaveLength(3);
    expect((keyEvents[0]!.params as { type: string; key: string }).type).toBe(
      "keyDown",
    );
    expect((keyEvents[0]!.params as { type: string; key: string }).key).toBe(
      "Enter",
    );
    expect((keyEvents[1]!.params as { type: string }).type).toBe("char");
    expect((keyEvents[2]!.params as { type: string }).type).toBe("keyUp");
    // Enter must come AFTER Input.insertText.
    const insertIdx = sendCalls.findIndex(
      (c) => c.method === "Input.insertText",
    );
    const firstKeyIdx = sendCalls.findIndex(
      (c) => c.method === "Input.dispatchKeyEvent",
    );
    expect(firstKeyIdx).toBeGreaterThan(insertIdx);
  });

  test("credential value NEVER appears in result content", async () => {
    snapshotBackendNodeMaps.set("test-conversation", new Map([["e1", 555]]));
    const result = await executeBrowserFillCredential(
      { service: "gmail", field: "password", element_id: "e1" },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("super-secret-password");
  });

  test("returns error when service is missing", async () => {
    snapshotBackendNodeMaps.set("test-conversation", new Map([["e1", 555]]));
    const result = await executeBrowserFillCredential(
      { field: "password", element_id: "e1" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("service is required");
  });

  test("returns error when field is missing", async () => {
    snapshotBackendNodeMaps.set("test-conversation", new Map([["e1", 555]]));
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
      snapshotBackendNodeMaps.set("test-conversation", new Map([["e1", 555]]));
      const result = await executeBrowserFillCredential(
        { service: "gmail", field: "password", element_id: "e1" },
        ctx,
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Filled password for gmail");
      expect(result.content).not.toContain("super-secret-password");
    });

    test("credential access goes through broker (metadata + value checked)", async () => {
      snapshotBackendNodeMaps.set("test-conversation", new Map([["e1", 555]]));
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
      snapshotBackendNodeMaps.set("test-conversation", new Map([["e1", 555]]));
      const result = await executeBrowserFillCredential(
        { service: "gmail", field: "password", element_id: "e1" },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Policy denied");
      expect(result.content).toContain("not allowed to use credential");
      expect(result.content).toContain("credential_store");
      // The broker short-circuits before Input.insertText fires.
      const methods = sendCalls.map((c) => c.method);
      expect(methods).not.toContain("Input.insertText");
    });

    test("returns domain policy denial with actionable message", async () => {
      mockGetCredentialMetadata = mock((service: string, field: string) => ({
        ...defaultMetadata(service, field),
        allowedDomains: ["other-site.com"],
      }));
      snapshotBackendNodeMaps.set("test-conversation", new Map([["e1", 555]]));
      const result = await executeBrowserFillCredential(
        { service: "gmail", field: "password", element_id: "e1" },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Domain policy denied");
      expect(result.content).toContain("Navigate to an allowed domain");
      const methods = sendCalls.map((c) => c.method);
      expect(methods).not.toContain("Input.insertText");
    });

    test("passes current page domain to broker", async () => {
      mockGetCredentialMetadata = mock((service: string, field: string) => ({
        ...defaultMetadata(service, field),
        allowedDomains: ["example.com"],
      }));
      snapshotBackendNodeMaps.set("test-conversation", new Map([["e1", 555]]));
      const result = await executeBrowserFillCredential(
        { service: "gmail", field: "password", element_id: "e1" },
        ctx,
      );
      // Default handler returns https://example.com/ → matches allowedDomains
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Filled password for gmail");
    });

    test("policy denial errors never contain credential values", async () => {
      mockGetCredentialMetadata = mock((service: string, field: string) => ({
        ...defaultMetadata(service, field),
        allowedTools: ["other_tool"],
      }));
      snapshotBackendNodeMaps.set("test-conversation", new Map([["e1", 555]]));
      const result = await executeBrowserFillCredential(
        { service: "gmail", field: "password", element_id: "e1" },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.content).not.toContain("super-secret-password");
    });
  });
});
