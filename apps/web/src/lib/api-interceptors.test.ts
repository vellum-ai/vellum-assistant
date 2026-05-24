/**
 * Unit tests for the HeyAPI client request interceptor.
 *
 * Pins the ATL-703 header contract: every outbound request — regardless of
 * method — must carry `X-Vellum-Client-Id` + `X-Vellum-Interface-Id` so the
 * daemon can echo the originator id back on `sync_changed` and the hub can
 * suppress the SSE echo to that subscriber.
 *
 * The test calls `requestInterceptor` directly instead of round-tripping
 * through the HeyAPI client. That way we don't depend on any private
 * interceptor-list internals; if the interceptor function gets the inputs
 * right, the registrations at the bottom of the module do the rest.
 *
 * @jest-environment happy-dom
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { requestInterceptor } from "@/lib/api-interceptors.js";
import { getClientId } from "@/lib/telemetry/client-identity.js";
import { useOrganizationStore } from "@/stores/organization-store.js";

const TEST_ORG_ID = "org-test-1234";

function setCsrfCookie(token: string): void {
  document.cookie = `csrftoken=${token}; path=/`;
}

function clearCsrfCookie(): void {
  document.cookie = "csrftoken=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
}

async function intercept(method: string, url = "https://example.test/v1/probe") {
  const request = new Request(url, { method });
  const result = await requestInterceptor(request);
  return result.headers;
}

describe("api-interceptors / requestInterceptor", () => {
  beforeAll(() => {
    useOrganizationStore.setState({ currentOrganizationId: TEST_ORG_ID });
    setCsrfCookie("test-csrf-token");
  });

  afterAll(() => {
    clearCsrfCookie();
  });

  test("attaches X-Vellum-Client-Id and X-Vellum-Interface-Id on GET", async () => {
    const headers = await intercept("GET");
    expect(headers.get("X-Vellum-Client-Id")).toBe(getClientId());
    expect(headers.get("X-Vellum-Interface-Id")).toBe("vellum");
  });

  test("attaches X-Vellum-Client-Id and X-Vellum-Interface-Id on POST", async () => {
    const headers = await intercept("POST");
    expect(headers.get("X-Vellum-Client-Id")).toBe(getClientId());
    expect(headers.get("X-Vellum-Interface-Id")).toBe("vellum");
  });

  test("attaches client + interface headers on PUT, PATCH, DELETE", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const headers = await intercept(method);
      expect(headers.get("X-Vellum-Client-Id")).toBe(getClientId());
      expect(headers.get("X-Vellum-Interface-Id")).toBe("vellum");
    }
  });

  test("attaches Vellum-Organization-Id when an active org is set", async () => {
    const headers = await intercept("GET");
    expect(headers.get("Vellum-Organization-Id")).toBe(TEST_ORG_ID);
  });

  test("attaches X-CSRFToken on mutating requests", async () => {
    const headers = await intercept("POST");
    expect(headers.get("X-CSRFToken")).toBe("test-csrf-token");
  });

  test("does not attach X-CSRFToken on safe requests", async () => {
    const headers = await intercept("GET");
    expect(headers.get("X-CSRFToken")).toBeNull();
  });

  test("returns a new Request, leaving the input headers untouched", async () => {
    const input = new Request("https://example.test/v1/probe", { method: "POST" });
    expect(input.headers.get("X-Vellum-Client-Id")).toBeNull();

    const output = await requestInterceptor(input);
    expect(output).not.toBe(input);
    expect(input.headers.get("X-Vellum-Client-Id")).toBeNull();
    expect(output.headers.get("X-Vellum-Client-Id")).toBe(getClientId());
  });
});
