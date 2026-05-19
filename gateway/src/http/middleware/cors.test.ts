import { describe, expect, test } from "bun:test";

import { corsHeaders, handlePreflight, resolveWebviewOrigin } from "./cors.js";

function makeRequest(origin: string | null): Request {
  const headers = new Headers();
  if (origin !== null) headers.set("origin", origin);
  return new Request("http://127.0.0.1:7830/v1/events", { headers });
}

describe("resolveWebviewOrigin", () => {
  test("matches the macOS WKWebView origin", () => {
    expect(resolveWebviewOrigin(makeRequest("https://eli.vellum.local"))).toBe(
      "https://eli.vellum.local",
    );
  });

  test("matches the Tauri production custom protocol origin", () => {
    expect(resolveWebviewOrigin(makeRequest("tauri://localhost"))).toBe(
      "tauri://localhost",
    );
  });

  test("matches the Tauri Windows-style host", () => {
    expect(resolveWebviewOrigin(makeRequest("http://tauri.localhost"))).toBe(
      "http://tauri.localhost",
    );
  });

  test("matches the Tauri dev server (any port)", () => {
    // Tauri's default `tauri dev` port is 1420, but users can change it.
    expect(resolveWebviewOrigin(makeRequest("http://localhost:1420"))).toBe(
      "http://localhost:1420",
    );
    expect(resolveWebviewOrigin(makeRequest("http://localhost:5173"))).toBe(
      "http://localhost:5173",
    );
  });

  test("rejects unrelated origins", () => {
    expect(resolveWebviewOrigin(makeRequest("https://example.com"))).toBeNull();
    expect(
      resolveWebviewOrigin(makeRequest("https://evil.vellum.local.attacker")),
    ).toBeNull();
    expect(
      resolveWebviewOrigin(makeRequest("http://127.0.0.1:1420")),
    ).toBeNull();
    expect(resolveWebviewOrigin(makeRequest(null))).toBeNull();
  });
});

describe("preflight allows SSE-required headers", () => {
  test("Allow-Headers covers the headers the HUD SSE client sends", () => {
    const headers = corsHeaders("tauri://localhost");
    const allow = headers["Access-Control-Allow-Headers"] ?? "";
    // The Tauri `GatewayEventStream` sends these on `/v1/events`. If
    // any are missing the browser blocks the preflight and the HUD
    // header shows "gateway offline" even though the daemon is healthy.
    for (const required of [
      "Authorization",
      "Accept",
      "X-Vellum-Interface-Id",
      "X-Vellum-Client-Id",
    ]) {
      expect(allow.toLowerCase().split(/\s*,\s*/)).toContain(
        required.toLowerCase(),
      );
    }
  });

  test("handlePreflight responds 204 with the matched origin", () => {
    const response = handlePreflight("tauri://localhost");
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "tauri://localhost",
    );
  });
});
