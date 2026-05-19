import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { subscribeAssistantUnreachable } from "@/lib/assistants/unreachable-bus.js";
import { setActiveOrganizationIdForRequests } from "@/lib/organization/organization-state.js";

import { requestInterceptor, responseInterceptor } from "@/lib/vellum-api/client.js";

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

describe("vellum api request interceptor", () => {
  beforeEach(() => {
    setActiveOrganizationIdForRequests(null);
  });

  afterEach(() => {
    setActiveOrganizationIdForRequests(null);
    if (originalDocument) {
      Object.defineProperty(globalThis, "document", originalDocument);
      return;
    }
    Reflect.deleteProperty(globalThis, "document");
  });

  test("adds Vellum-Organization-Id header when org state is set", async () => {
    setActiveOrganizationIdForRequests("org-123");

    const request = new Request("http://localhost/v1/admin/users/", {
      method: "GET",
    });
    const intercepted = await requestInterceptor(request);

    expect(intercepted.headers.get("Vellum-Organization-Id")).toBe("org-123");
  });

  test("does not add Vellum-Organization-Id when org state is empty", async () => {
    const request = new Request("http://localhost/v1/admin/users/", {
      method: "GET",
    });
    const intercepted = await requestInterceptor(request);

    expect(intercepted.headers.get("Vellum-Organization-Id")).toBeNull();
  });

  test("adds CSRF and organization headers on mutating requests", async () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        cookie: "csrftoken=test-csrf-token",
      },
    });
    setActiveOrganizationIdForRequests("org-123");

    const request = new Request("http://localhost/v1/assistants/hatch/", {
      method: "POST",
    });
    const intercepted = await requestInterceptor(request);

    expect(intercepted.headers.get("Vellum-Organization-Id")).toBe("org-123");
    expect(intercepted.headers.get("X-CSRFToken")).toBe("test-csrf-token");
  });
});

describe("vellum api response interceptor", () => {
  test("notifies the unreachable bus on 503 for non connection-status URLs", () => {
    const listener = mock(() => {});
    const unsubscribe = subscribeAssistantUnreachable(listener);
    try {
      const response = new Response(null, { status: 503 });
      Object.defineProperty(response, "url", {
        value: "http://localhost/v1/assistants/abc/messages/",
      });

      const returned = responseInterceptor(response);

      expect(returned).toBe(response);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  test.each([502, 503, 504])(
    "notifies the unreachable bus on %d",
    (status) => {
      const listener = mock(() => {});
      const unsubscribe = subscribeAssistantUnreachable(listener);
      try {
        const response = new Response(null, { status });
        Object.defineProperty(response, "url", {
          value: "http://localhost/v1/assistants/abc/messages/",
        });
        responseInterceptor(response);
        expect(listener).toHaveBeenCalledTimes(1);
      } finally {
        unsubscribe();
      }
    },
  );

  test("ignores 200 responses", () => {
    const listener = mock(() => {});
    const unsubscribe = subscribeAssistantUnreachable(listener);
    try {
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, "url", {
        value: "http://localhost/v1/assistants/abc/messages/",
      });
      responseInterceptor(response);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  test("ignores 503s from the connection-status endpoint to avoid a probe loop", () => {
    const listener = mock(() => {});
    const unsubscribe = subscribeAssistantUnreachable(listener);
    try {
      const response = new Response(null, { status: 503 });
      Object.defineProperty(response, "url", {
        value: "http://localhost/v1/assistants/abc/connection-status/",
      });
      responseInterceptor(response);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  test("ignores 503s from STT routes — feature-level error, not pod unreachable", () => {
    const listener = mock(() => {});
    const unsubscribe = subscribeAssistantUnreachable(listener);
    try {
      const response = new Response(null, { status: 503 });
      Object.defineProperty(response, "url", {
        value: "http://localhost/v1/assistants/abc/stt/transcribe",
      });
      responseInterceptor(response);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  test("ignores 502s from /pro-upgrade-machine/ — feature-level error, not pod unreachable", () => {
    const listener = mock(() => {});
    const unsubscribe = subscribeAssistantUnreachable(listener);
    try {
      const response = new Response(null, { status: 502 });
      Object.defineProperty(response, "url", {
        value: "http://localhost/v1/assistants/abc/pro-upgrade-machine/",
      });
      responseInterceptor(response);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  test("ignores 503s from /hatch/ — platform-hosted-enabled capacity gate, not pod unreachable", () => {
    // The hatch endpoint returns 503 with `code: platform_hosted_disabled`
    // when the LaunchDarkly kill-switch is engaged. The chat-page auto-hatch
    // path would otherwise stack the connecting overlay on top of the
    // tailored at-capacity message. Tracked alongside the
    // `isPlatformHostedDisabled` handling in `lib/assistants/lifecycle.ts`.
    const listener = mock(() => {});
    const unsubscribe = subscribeAssistantUnreachable(listener);
    try {
      const response = new Response(null, { status: 503 });
      Object.defineProperty(response, "url", {
        value: "http://localhost/v1/assistants/hatch/",
      });
      responseInterceptor(response);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});
