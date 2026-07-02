import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the effective-timezone resolver so we can control the zone
// `postChatMessage` reads at send time without touching localStorage/Intl.
let mockEffectiveTimezone = "America/New_York";
mock.module("@/utils/effective-timezone", () => ({
  getEffectiveTimezone: () => mockEffectiveTimezone,
}));

import { postChatMessage } from "@/domains/chat/api/messages";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

describe("postChatMessage onboarding payload", () => {
  let originalFetch: typeof fetch;
  let originalDocument: unknown;
  let capturedRequests: Array<{ url: string; body: string }> = [];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedRequests = [];
    // Reset the assistant-identity store so version-gated wire-field
    // selection in `postChatMessage` defaults to the conservative legacy
    // `conversationKey` path. Individual tests that exercise the new
    // `conversationId` path opt in explicitly via `setIdentity(...)`.
    useAssistantIdentityStore.getState().clearIdentity();
    // The vellum-api client request interceptor calls ensureCsrfCookie() on
    // mutating requests, which reads `document.cookie`. Stub a minimal
    // `document` so the bun test (Node) environment doesn't throw.
    originalDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { cookie: "csrftoken=test" };
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      // The heyapi client passes a Request object as `input`; read the body
      // by cloning and calling `.text()` so we can decode the JSON payload.
      const url = input instanceof Request ? input.url : String(input);
      let bodyText: string | undefined;
      if (input instanceof Request) {
        bodyText = await input.clone().text();
      } else if (typeof init?.body === "string") {
        bodyText = init.body;
      }
      capturedRequests.push({ url, body: bodyText ?? "" });
      if (url.includes("/workspace/file")) {
        return new Response(JSON.stringify({ detail: "File not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/workspace/write")) {
        return new Response(JSON.stringify({ path: "users/guardian.md", size: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          accepted: true,
          messageId: "msg-1",
          conversationId: "conv-resp-1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document?: unknown }).document = originalDocument;
    }
  });

  function getRequestBody(): Record<string, unknown> {
    const messageRequests = capturedRequests.filter((request) =>
      request.url.includes("/messages"),
    );
    expect(messageRequests).toHaveLength(1);
    const rawBody = messageRequests[0]!.body;
    expect(rawBody.length).toBeGreaterThan(0);
    return JSON.parse(rawBody) as Record<string, unknown>;
  }

  function getWorkspaceWriteBodies(): Record<string, unknown>[] {
    return capturedRequests
      .filter((request) => request.url.includes("/workspace/write"))
      .map((request) => JSON.parse(request.body) as Record<string, unknown>);
  }

  test("omits onboarding field when arg is undefined", async () => {
    const result = await postChatMessage("asst-1", "K", "hello");
    expect(result.ok).toBe(true);

    expect(capturedRequests).toHaveLength(1);
    const body = getRequestBody();
    expect(body).not.toHaveProperty("onboarding");
    expect(body.conversationKey).toBe("K");
    expect(body.content).toBe("hello");
  });

  test("includes normalized onboarding and seeds profile files concurrently with the message post", async () => {
    await postChatMessage("asst-1", "K", "hello", {
      onboarding: {
        tools: ["github", "linear"],
        tasks: ["code-building", "writing"],
        tone: "friendly",
        userName: "Ada",
        occupation: "Software Engineer",
        assistantName: "Vel",
      },
    });
    // Profile seeding is fire-and-forget — flush the microtask queue so
    // the concurrent writes settle before we assert.
    await new Promise((r) => setTimeout(r, 0));

    const body = getRequestBody();
    expect(body.onboarding).toEqual({
      tools: ["GitHub", "Linear"],
      tasks: ["builds code, apps, or tools", "writes docs, emails, or content"],
      tone: "friendly",
      userName: "Ada",
      occupation: "Software Engineer",
      assistantName: "Vel",
    });

    const writes = getWorkspaceWriteBodies();
    expect(writes.map((write) => write.path).sort()).toEqual([
      "users/default.md",
      "users/guardian.md",
    ]);
    for (const write of writes) {
      expect(write.content).toContain("## Onboarding Context");
      expect(write.content).toContain("- **Preferred name:** Ada");
      expect(write.content).toContain("- **Role:** Software Engineer");
      expect(write.content).toContain(
        "- **Common work:** builds code, apps, or tools; writes docs, emails, or content",
      );
      expect(write.content).toContain("- **Daily tools:** GitHub, Linear");
    }
  });

  test("excludes userName when undefined (matches macOS `if let userName`)", async () => {
    await postChatMessage("asst-1", "K", "hello", {
      onboarding: {
        tools: ["github"],
        tasks: ["plan"],
        tone: "concise",
        // userName intentionally omitted
        assistantName: "Vel",
      },
    });

    const body = getRequestBody();
    expect(body.onboarding).toEqual({
      tools: ["GitHub"],
      tasks: ["plan"],
      tone: "concise",
      assistantName: "Vel",
    });
    const onboarding = body.onboarding as Record<string, unknown>;
    expect(onboarding).not.toHaveProperty("userName");
  });

  test("preserves empty-string userName/assistantName on the wire (matches macOS `if let` non-nil semantics)", async () => {
    // Codex P2 regression guard: a caller that intentionally sends "" to
    // represent a blank-but-present name must reach the wire untouched —
    // truthy checks would silently drop these and diverge from macOS.
    await postChatMessage("asst-1", "K", "hello", {
      onboarding: {
        tools: ["github"],
        tasks: ["plan"],
        tone: "concise",
        userName: "",
        assistantName: "",
      },
    });

    const body = getRequestBody();
    expect(body.onboarding).toEqual({
      tools: ["GitHub"],
      tasks: ["plan"],
      tone: "concise",
      userName: "",
      assistantName: "",
    });
  });

  test("includes empty tools/tasks arrays as valid wire payload", async () => {
    await postChatMessage("asst-1", "K", "hello", {
      onboarding: {
        tools: [],
        tasks: [],
        tone: "neutral",
      },
    });

    const body = getRequestBody();
    expect(body.onboarding).toEqual({
      tools: [],
      tasks: [],
      tone: "neutral",
    });
    const onboarding = body.onboarding as Record<string, unknown>;
    expect(onboarding).not.toHaveProperty("userName");
    expect(onboarding).not.toHaveProperty("assistantName");
  });
});

describe("postChatMessage wire-field bilingual cutover", () => {
  // Verifies the assistant-version gate picks exactly ONE wire field
  // on `POST /v1/messages`:
  //   - 0.8.6+ assistants: `conversationId` only (strict internal-id
  //     lookup; the server-mint path takes the null branch).
  //   - pre-0.8.6 assistants: `conversationKey` only (legacy
  //     create-or-lookup), always sent — including `conversationKey:
  //     null` — so the legacy path is always exercised.
  // See `lib/backwards-compat/conversation-id-wire-field.ts`.
  let originalFetch: typeof fetch;
  let originalDocument: unknown;
  let capturedRequests: Array<{ url: string; body: string }> = [];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedRequests = [];
    useAssistantIdentityStore.getState().clearIdentity();
    originalDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { cookie: "csrftoken=test" };
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      let bodyText: string | undefined;
      if (input instanceof Request) {
        bodyText = await input.clone().text();
      } else if (typeof init?.body === "string") {
        bodyText = init.body;
      }
      capturedRequests.push({ url, body: bodyText ?? "" });
      return new Response(
        JSON.stringify({
          accepted: true,
          messageId: "msg-1",
          conversationId: "conv-resp-1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document?: unknown }).document = originalDocument;
    }
    useAssistantIdentityStore.getState().clearIdentity();
  });

  function getMessageBody(): Record<string, unknown> {
    const requests = capturedRequests.filter((r) => r.url.includes("/messages"));
    expect(requests).toHaveLength(1);
    return JSON.parse(requests[0]!.body) as Record<string, unknown>;
  }

  test("sends only conversationId on 0.8.6 assistants (no duplicate conversationKey)", async () => {
    useAssistantIdentityStore.getState().setIdentity("Vel", "0.8.6");

    await postChatMessage("asst-1", "conv-internal-1", "hi");

    const body = getMessageBody();
    expect(body.conversationId).toBe("conv-internal-1");
    expect(body).not.toHaveProperty("conversationKey");
  });

  test("sends only conversationId on newer assistants (e.g. 0.9.0)", async () => {
    useAssistantIdentityStore.getState().setIdentity("Vel", "0.9.0");

    await postChatMessage("asst-1", "conv-internal-2", "hi");

    const body = getMessageBody();
    expect(body.conversationId).toBe("conv-internal-2");
    expect(body).not.toHaveProperty("conversationKey");
  });

  test("sends only conversationKey on assistants older than 0.8.6", async () => {
    useAssistantIdentityStore.getState().setIdentity("Vel", "0.8.5");

    await postChatMessage("asst-1", "conv-internal-3", "hi");

    const body = getMessageBody();
    expect(body.conversationKey).toBe("conv-internal-3");
    expect(body).not.toHaveProperty("conversationId");
  });

  test("falls back to conversationKey only when assistant version is unknown (identity not yet hydrated)", async () => {
    // Default store state: version === null. This is the window
    // between page load and the identity fetch resolving.
    expect(useAssistantIdentityStore.getState().version).toBeNull();

    await postChatMessage("asst-1", "conv-internal-4", "hi");

    const body = getMessageBody();
    expect(body.conversationKey).toBe("conv-internal-4");
    expect(body).not.toHaveProperty("conversationId");
  });

  test("still sends conversationKey: null on pre-0.8.6 assistants when caller passes null", async () => {
    // Defense in depth: a caller that bypasses
    // `supportsServerMintedConversation()` and passes null to an older
    // assistant must still hit the legacy create-or-lookup path. The
    // wire field is sent with a null value rather than omitted so
    // pre-0.8.6 backends see a familiar shape.
    useAssistantIdentityStore.getState().setIdentity("Vel", "0.8.5");

    await postChatMessage("asst-1", null, "hi");

    const body = getMessageBody();
    expect(body).toHaveProperty("conversationKey");
    expect(body.conversationKey).toBeNull();
    expect(body).not.toHaveProperty("conversationId");
  });
});

describe("postChatMessage server-minted conversation flow", () => {
  // Verifies the `conversationId === null` contract: caller asks the
  // assistant to mint a conversation row by omitting both wire fields,
  // and the assistant returns the freshly minted id back on the
  // response (which becomes `result.conversationId` so the caller can
  // navigate). See `lib/backwards-compat/server-minted-conversation.ts`
  // for the version gate that decides when callers may pass null.
  let originalFetch: typeof fetch;
  let originalDocument: unknown;
  let capturedRequests: Array<{ url: string; body: string }> = [];
  let nextResponseBody: Record<string, unknown> = {
    accepted: true,
    messageId: "msg-1",
    conversationId: "conv-server-minted-1",
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedRequests = [];
    nextResponseBody = {
      accepted: true,
      messageId: "msg-1",
      conversationId: "conv-server-minted-1",
    };
    useAssistantIdentityStore.getState().clearIdentity();
    originalDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { cookie: "csrftoken=test" };
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      let bodyText: string | undefined;
      if (input instanceof Request) {
        bodyText = await input.clone().text();
      } else if (typeof init?.body === "string") {
        bodyText = init.body;
      }
      capturedRequests.push({ url, body: bodyText ?? "" });
      return new Response(JSON.stringify(nextResponseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document?: unknown }).document = originalDocument;
    }
    useAssistantIdentityStore.getState().clearIdentity();
  });

  function getMessageBody(): Record<string, unknown> {
    const requests = capturedRequests.filter((r) => r.url.includes("/messages"));
    expect(requests).toHaveLength(1);
    return JSON.parse(requests[0]!.body) as Record<string, unknown>;
  }

  test("omits both wire fields when conversationId is null (server-mint flow)", async () => {
    useAssistantIdentityStore.getState().setIdentity("Vel", "0.8.6");

    const result = await postChatMessage("asst-1", null, "hello");

    const body = getMessageBody();
    expect(body).not.toHaveProperty("conversationId");
    expect(body).not.toHaveProperty("conversationKey");
    expect(body.content).toBe("hello");
    expect(body.sourceChannel).toBe("vellum");
    expect(result.ok).toBe(true);
  });

  test("returns the assistant-minted id as the authoritative conversationId", async () => {
    useAssistantIdentityStore.getState().setIdentity("Vel", "0.8.6");
    nextResponseBody = {
      accepted: true,
      messageId: "msg-2",
      conversationId: "conv-from-assistant-xyz",
    };

    const result = await postChatMessage("asst-1", null, "hi");

    if (!result.ok) {
      throw new Error("expected success");
    }
    if (result.queued) {
      throw new Error("expected synchronous (non-queued) result");
    }
    expect(result.conversationId).toBe("conv-from-assistant-xyz");
    expect(result.messageId).toBe("msg-2");
  });

  test("returns the assistant's conversationId even when caller supplied one (server is authoritative)", async () => {
    // Even on the non-null path, `result.conversationId` reflects what
    // the assistant returned on the wire — not what the caller passed
    // in. This makes the result shape uniform and lets downstream code
    // trust the single field as the source of truth.
    useAssistantIdentityStore.getState().setIdentity("Vel", "0.8.6");
    nextResponseBody = {
      accepted: true,
      messageId: "msg-x",
      conversationId: "conv-from-assistant-canonical",
    };

    const result = await postChatMessage("asst-1", "conv-caller-input", "hi");

    if (!result.ok) {
      throw new Error("expected success");
    }
    if (result.queued) {
      throw new Error("expected synchronous (non-queued) result");
    }
    expect(result.conversationId).toBe("conv-from-assistant-canonical");
  });

  test("fails with 422 when caller asks for server-mint but assistant does not return a conversation id", async () => {
    useAssistantIdentityStore.getState().setIdentity("Vel", "0.8.6");
    // Assistant accepted the message but returned no conversationId —
    // a broken contract for the server-mint path. The caller would
    // have no id to navigate to, so this must surface as a failure
    // rather than silently propagating an empty value downstream.
    nextResponseBody = { accepted: true, messageId: "msg-3" };

    const result = await postChatMessage("asst-1", null, "hi");

    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.status).toBe(422);
    expect(result.error.detail).toContain("did not return a conversation id");
  });

  test("still uses conversationKey wire field when conversationId is provided (legacy non-null path unchanged)", async () => {
    // On assistants older than 0.8.6, the wire-field gate still picks
    // `conversationKey` only — the `conversationId` field is not added
    // because pre-0.8.6 assistants don't read it.
    useAssistantIdentityStore.getState().setIdentity("Vel", "0.8.5");

    await postChatMessage("asst-1", "conv-existing", "hi");

    const body = getMessageBody();
    expect(body.conversationKey).toBe("conv-existing");
    expect(body).not.toHaveProperty("conversationId");
  });
});

describe("postChatMessage clientTimezone payload", () => {
  // Every message carries the live effective timezone so the assistant's
  // per-turn time awareness stays current as the OS/browser zone changes.
  // The daemon route (`conversation-routes.ts`) consumes `clientTimezone`
  // in its turn-timezone cascade — no backend change is needed here.
  let originalFetch: typeof fetch;
  let originalDocument: unknown;
  let capturedRequests: Array<{ url: string; body: string }> = [];

  beforeEach(() => {
    mockEffectiveTimezone = "America/New_York";
    originalFetch = globalThis.fetch;
    capturedRequests = [];
    useAssistantIdentityStore.getState().clearIdentity();
    originalDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { cookie: "csrftoken=test" };
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      let bodyText: string | undefined;
      if (input instanceof Request) {
        bodyText = await input.clone().text();
      } else if (typeof init?.body === "string") {
        bodyText = init.body;
      }
      capturedRequests.push({ url, body: bodyText ?? "" });
      return new Response(
        JSON.stringify({
          accepted: true,
          messageId: "msg-1",
          conversationId: "conv-resp-1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document?: unknown }).document = originalDocument;
    }
    useAssistantIdentityStore.getState().clearIdentity();
  });

  function getMessageBody(): Record<string, unknown> {
    const requests = capturedRequests.filter((r) => r.url.includes("/messages"));
    expect(requests).toHaveLength(1);
    return JSON.parse(requests[0]!.body) as Record<string, unknown>;
  }

  test("includes the live effective timezone on the wire", async () => {
    mockEffectiveTimezone = "Europe/Berlin";

    await postChatMessage("asst-1", "K", "hello");

    const body = getMessageBody();
    expect(body.clientTimezone).toBe("Europe/Berlin");
  });

  test("reflects a changed zone on the next message (read live at send time)", async () => {
    await postChatMessage("asst-1", "K", "first");
    expect(getMessageBody().clientTimezone).toBe("America/New_York");

    capturedRequests = [];
    mockEffectiveTimezone = "Asia/Tokyo";

    await postChatMessage("asst-1", "K", "second");
    expect(getMessageBody().clientTimezone).toBe("Asia/Tokyo");
  });

  test("omits clientTimezone when the resolver returns an empty string", async () => {
    mockEffectiveTimezone = "";

    await postChatMessage("asst-1", "K", "hello");

    const body = getMessageBody();
    expect(body).not.toHaveProperty("clientTimezone");
  });
});
