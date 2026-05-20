import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { postChatMessage } from "@/domains/chat/api/messages.js";

describe("postChatMessage onboarding payload", () => {
  let originalFetch: typeof fetch;
  let originalDocument: unknown;
  let capturedRequests: Array<{ url: string; body: string }> = [];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedRequests = [];
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
      if (url.includes("/workspace/file/")) {
        return new Response(JSON.stringify({ detail: "File not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/workspace/write/")) {
        return new Response(JSON.stringify({ path: "users/guardian.md", size: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ accepted: true, messageId: "msg-1" }),
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
      request.url.includes("/messages/"),
    );
    expect(messageRequests).toHaveLength(1);
    const rawBody = messageRequests[0]!.body;
    expect(rawBody.length).toBeGreaterThan(0);
    return JSON.parse(rawBody) as Record<string, unknown>;
  }

  function getWorkspaceWriteBodies(): Record<string, unknown>[] {
    return capturedRequests
      .filter((request) => request.url.includes("/workspace/write/"))
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

  test("includes normalized onboarding and seeds profile files before posting the message", async () => {
    await postChatMessage("asst-1", "K", "hello", [], {
      tools: ["github", "linear"],
      tasks: ["code-building", "writing"],
      tone: "friendly",
      userName: "Ada",
      assistantName: "Vel",
    });

    expect(capturedRequests.at(-1)?.url).toContain("/messages/");
    const body = getRequestBody();
    expect(body.onboarding).toEqual({
      tools: ["GitHub", "Linear"],
      tasks: ["builds code, apps, or tools", "writes docs, emails, or content"],
      tone: "friendly",
      userName: "Ada",
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
      expect(write.content).toContain(
        "- **Common work:** builds code, apps, or tools; writes docs, emails, or content",
      );
      expect(write.content).toContain("- **Daily tools:** GitHub, Linear");
    }
  });

  test("excludes userName when undefined (matches macOS `if let userName`)", async () => {
    await postChatMessage("asst-1", "K", "hello", [], {
      tools: ["github"],
      tasks: ["plan"],
      tone: "concise",
      // userName intentionally omitted
      assistantName: "Vel",
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
    await postChatMessage("asst-1", "K", "hello", [], {
      tools: ["github"],
      tasks: ["plan"],
      tone: "concise",
      userName: "",
      assistantName: "",
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
    await postChatMessage("asst-1", "K", "hello", [], {
      tools: [],
      tasks: [],
      tone: "neutral",
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
