import { describe, expect, test } from "bun:test";

import {
  type CdpClient,
  type CdpClientKind,
  CdpError,
  type CdpErrorCode,
  type ScopedCdpClient,
} from "../index.js";

describe("CdpError", () => {
  test("subclasses Error", () => {
    const err = new CdpError("cdp_error", "boom");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CdpError);
  });

  test("sets name to CdpError", () => {
    const err = new CdpError("aborted", "test");
    expect(err.name).toBe("CdpError");
  });

  test("captures code, message, and default details", () => {
    const err = new CdpError("aborted", "caller aborted");
    expect(err.code).toBe("aborted");
    expect(err.message).toBe("caller aborted");
    expect(err.cdpMethod).toBeUndefined();
    expect(err.cdpParams).toBeUndefined();
    expect(err.underlying).toBeUndefined();
  });

  test("captures cdpMethod, cdpParams, and underlying when provided", () => {
    const cause = new Error("socket closed");
    const err = new CdpError("transport_error", "send failed", {
      cdpMethod: "Page.navigate",
      cdpParams: { url: "https://example.com/" },
      underlying: cause,
    });
    expect(err.code).toBe("transport_error");
    expect(err.cdpMethod).toBe("Page.navigate");
    expect(err.cdpParams).toEqual({ url: "https://example.com/" });
    expect(err.underlying).toBe(cause);
  });

  test("supports all documented CdpErrorCode values", () => {
    const codes: CdpErrorCode[] = [
      "cdp_error",
      "transport_error",
      "aborted",
      "disposed",
    ];
    for (const code of codes) {
      const err = new CdpError(code, `code ${code}`);
      expect(err.code).toBe(code);
    }
  });
});

describe("cdp-client re-exports", () => {
  test("CdpError is reachable from index", () => {
    expect(CdpError).toBeDefined();
    expect(typeof CdpError).toBe("function");
  });

  test("CdpClient interface is structurally assignable", () => {
    // Compile-time: ensure CdpClient is importable and can be implemented.
    const stub: CdpClient = {
      send: async <T = unknown>(
        _method: string,
        _params?: Record<string, unknown>,
        _signal?: AbortSignal,
      ): Promise<T> => {
        throw new CdpError("disposed", "stub");
      },
      dispose: () => {},
    };
    expect(typeof stub.send).toBe("function");
    expect(typeof stub.dispose).toBe("function");
  });

  test("ScopedCdpClient exposes kind and conversationId", () => {
    const kinds: CdpClientKind[] = ["local", "extension", "cdp-inspect"];
    for (const kind of kinds) {
      const scoped: ScopedCdpClient = {
        kind,
        conversationId: "conv-123",
        send: async <T = unknown>(): Promise<T> => {
          throw new CdpError("disposed", "stub");
        },
        dispose: () => {},
      };
      expect(scoped.kind).toBe(kind);
      expect(scoped.conversationId).toBe("conv-123");
    }
  });
});
