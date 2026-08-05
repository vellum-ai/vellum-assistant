import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import {
  buildDeslopPrompt,
  buildHighlightedUserTurn,
  capTranscript,
  requestDeslopChat,
  requestDeslopRewrite,
  DESLOP_CHAT_SYSTEM_PROMPT,
  DESLOP_SYSTEM_PROMPT,
  type DeslopTranscriptTurn,
} from "../deslop.js";

const originalFetch = globalThis.fetch;

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

function installFetchMock(
  captured: CapturedRequest[],
  respond: (callIndex: number) => Response,
): void {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const callIndex = captured.length;
    captured.push({ url: String(input), init });
    return respond(callIndex);
  }) as typeof fetch;
}

function parseBody(request: CapturedRequest): Record<string, unknown> {
  return JSON.parse(String(request.init?.body)) as Record<string, unknown>;
}

function installChromeStorageMock(local: Record<string, unknown>): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        async get(keys?: string | string[]) {
          if (typeof keys === "string") {
            return keys in local ? { [keys]: local[keys] } : {};
          }
          return { ...local };
        },
      },
    },
  };
}

beforeEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe("buildDeslopPrompt", () => {
  test("wraps the selected text in the rewrite prompt", () => {
    const prompt = buildDeslopPrompt("synergize the deliverables");
    expect(prompt).toContain(
      "<selected_text>synergize the deliverables</selected_text>",
    );
    expect(prompt).toContain("without any jargon");
    expect(prompt).toContain("one human talking to another");
  });

  test("asks aggressively for a shorter rewrite", () => {
    const prompt = buildDeslopPrompt("text");
    expect(prompt).toContain("much more simply and concisely");
    expect(prompt).toContain("Be aggressive about cutting length");
    expect(prompt).toContain("at most half the original length");
    expect(prompt).toContain("Remove fluff and pleasantries entirely");
    expect(prompt).toContain("Start directly with the substance");
  });
});

describe("buildHighlightedUserTurn", () => {
  test("wraps the highlighted page text alongside the message", () => {
    expect(buildHighlightedUserTurn("the fine print", "what does this mean?")).toBe(
      "<user_highlighted>the fine print</user_highlighted> what does this mean?",
    );
  });

  test("returns the bare message when nothing is highlighted", () => {
    expect(buildHighlightedUserTurn("", "what does this mean?")).toBe(
      "what does this mean?",
    );
  });
});

describe("capTranscript", () => {
  function makeTurns(count: number): DeslopTranscriptTurn[] {
    return Array.from({ length: count }, (_unused, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `${index}`.padEnd(60, "x"),
    }));
  }

  test("returns the transcript untouched when it fits", () => {
    const turns = makeTurns(6);
    expect(capTranscript(turns, 100_000)).toBe(turns);
  });

  test("drops the oldest turns in pairs until it fits", () => {
    const turns = makeTurns(6);
    const capped = capTranscript(turns, 400);

    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(400);
    expect(capped.length).toBe(4);
    expect(capped[0]).toEqual(turns[2]!);
    expect(capped[3]).toEqual(turns[5]!);
    expect(capped[0]!.role).toBe("user");
  });

  test("keeps the most recent turns even when a single turn exceeds the cap", () => {
    const turns = makeTurns(5);
    const capped = capTranscript(turns, 10);

    expect(capped.length).toBe(1);
    expect(capped[0]).toEqual(turns[4]!);
  });
});

describe("requestDeslopRewrite (self-hosted)", () => {
  test("posts to the gateway inference endpoint with the pair token", async () => {
    const captured: CapturedRequest[] = [];
    installFetchMock(captured, () =>
      Response.json({ response: "  Plain words.  " }),
    );

    const rewritten = await requestDeslopRewrite("leverage synergies", {
      kind: "self-hosted",
      gatewayUrl: "http://127.0.0.1:7830/",
      pairToken: "jwt-123",
    });

    expect(rewritten).toBe("Plain words.");
    expect(captured.length).toBe(1);
    expect(captured[0]!.url).toBe("http://127.0.0.1:7830/v1/inference/send");
    const headers = captured[0]!.init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer jwt-123");
    const body = parseBody(captured[0]!);
    expect(body["message"]).toContain(
      "<selected_text>leverage synergies</selected_text>",
    );
    expect(body["systemPrompt"]).toBe(DESLOP_SYSTEM_PROMPT);
    expect(body["profile"]).toBe("latency-optimized");
  });

  test("omits the authorization header when no pair token exists", async () => {
    const captured: CapturedRequest[] = [];
    installFetchMock(captured, () => Response.json({ response: "ok text" }));

    await requestDeslopRewrite("text", {
      kind: "self-hosted",
      gatewayUrl: "http://127.0.0.1:7830",
      pairToken: null,
    });

    const headers = captured[0]!.init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBeUndefined();
  });

  test("throws with status detail on a non-OK response", async () => {
    installFetchMock([], () => new Response("nope", { status: 403 }));

    await expect(
      requestDeslopRewrite("text", {
        kind: "self-hosted",
        gatewayUrl: "http://127.0.0.1:7830",
        pairToken: "jwt",
      }),
    ).rejects.toThrow(/403.*nope/);
  });

  const profileRejectionBodies: Array<[string, string]> = [
    [
      "a JSON error envelope",
      '{"error":"Profile \\"latency-optimized\\" is disabled"}',
    ],
    ["a plain text body", 'Profile "latency-optimized" is disabled'],
  ];

  for (const [label, rejectionBody] of profileRejectionBodies) {
    test(`retries without the profile when the assistant rejects it in ${label}`, async () => {
      const captured: CapturedRequest[] = [];
      installFetchMock(captured, (callIndex) =>
        callIndex === 0
          ? new Response(rejectionBody, { status: 400 })
          : Response.json({ response: "Plain words." }),
      );

      const rewritten = await requestDeslopRewrite("text", {
        kind: "self-hosted",
        gatewayUrl: "http://127.0.0.1:7830",
        pairToken: "jwt",
      });

      expect(rewritten).toBe("Plain words.");
      expect(captured.length).toBe(2);
      expect(parseBody(captured[0]!)["profile"]).toBe("latency-optimized");
      expect(parseBody(captured[1]!)).not.toHaveProperty("profile");
      expect(parseBody(captured[1]!)["systemPrompt"]).toBe(DESLOP_SYSTEM_PROMPT);
    });
  }

  test("does not retry a 400 that is not a profile rejection", async () => {
    const captured: CapturedRequest[] = [];
    installFetchMock(
      captured,
      () =>
        new Response('{"error":"message must be a non-empty string"}', {
          status: 400,
        }),
    );

    await expect(
      requestDeslopRewrite("text", {
        kind: "self-hosted",
        gatewayUrl: "http://127.0.0.1:7830",
        pairToken: "jwt",
      }),
    ).rejects.toThrow(/400.*non-empty string/);
    expect(captured.length).toBe(1);
  });

  test("throws when the assistant returns an empty rewrite", async () => {
    installFetchMock([], () => Response.json({ response: "   " }));

    await expect(
      requestDeslopRewrite("text", {
        kind: "self-hosted",
        gatewayUrl: "http://127.0.0.1:7830",
        pairToken: "jwt",
      }),
    ).rejects.toThrow(/empty rewrite/);
  });
});

describe("requestDeslopRewrite (cloud)", () => {
  test("posts through the platform wildcard proxy with session headers", async () => {
    installChromeStorageMock({
      "vellum.cloudSession": {
        email: "user@example.com",
        environment: "dev",
        sessionToken: "sess-token",
        organizationId: "org-abc",
      },
    });
    const captured: CapturedRequest[] = [];
    installFetchMock(captured, () => Response.json({ response: "Cleaner." }));

    const rewritten = await requestDeslopRewrite("obfuscated verbiage", {
      kind: "cloud",
      environment: "dev",
      assistantId: "assistant-1",
    });

    expect(rewritten).toBe("Cleaner.");
    expect(captured.length).toBe(1);
    expect(captured[0]!.url).toContain(
      "/v1/assistants/assistant-1/inference/send",
    );
    const headers = captured[0]!.init?.headers as Record<string, string>;
    expect(headers["X-Session-Token"]).toBe("sess-token");
    expect(headers["Vellum-Organization-Id"]).toBe("org-abc");
  });
});

describe("requestDeslopChat", () => {
  const transcript: DeslopTranscriptTurn[] = [
    { role: "user", content: "rewrite this" },
    { role: "assistant", content: "Rewritten." },
    {
      role: "user",
      content: "<user_highlighted>the fine print</user_highlighted> why?",
    },
  ];

  test("sends the transcript as messages and returns the trimmed reply", async () => {
    const captured: CapturedRequest[] = [];
    installFetchMock(captured, () =>
      Response.json({ response: "  Because of the clause.  " }),
    );

    const reply = await requestDeslopChat(transcript, {
      kind: "self-hosted",
      gatewayUrl: "http://127.0.0.1:7830",
      pairToken: "jwt-123",
    });

    expect(reply).toBe("Because of the clause.");
    expect(captured.length).toBe(1);
    expect(captured[0]!.url).toBe("http://127.0.0.1:7830/v1/inference/send");
    const body = parseBody(captured[0]!);
    expect(body["messages"]).toEqual(transcript);
    expect(body).not.toHaveProperty("message");
    expect(body["systemPrompt"]).toBe(DESLOP_CHAT_SYSTEM_PROMPT);
    expect(body["profile"]).toBe("latency-optimized");
  });

  test("retries without the profile when the assistant rejects it", async () => {
    const captured: CapturedRequest[] = [];
    installFetchMock(captured, (callIndex) =>
      callIndex === 0
        ? new Response('{"error":"Profile \\"latency-optimized\\" is disabled"}', {
            status: 400,
          })
        : Response.json({ response: "Because of the clause." }),
    );

    const reply = await requestDeslopChat(transcript, {
      kind: "self-hosted",
      gatewayUrl: "http://127.0.0.1:7830",
      pairToken: null,
    });

    expect(reply).toBe("Because of the clause.");
    expect(captured.length).toBe(2);
    expect(parseBody(captured[0]!)["profile"]).toBe("latency-optimized");
    const retried = parseBody(captured[1]!);
    expect(retried).not.toHaveProperty("profile");
    expect(retried).not.toHaveProperty("message");
    expect(retried["messages"]).toEqual(transcript);
    expect(retried["systemPrompt"]).toBe(DESLOP_CHAT_SYSTEM_PROMPT);
  });

  test("throws with status detail on a non-OK response", async () => {
    installFetchMock([], () => new Response("nope", { status: 500 }));

    await expect(
      requestDeslopChat(transcript, {
        kind: "self-hosted",
        gatewayUrl: "http://127.0.0.1:7830",
        pairToken: "jwt",
      }),
    ).rejects.toThrow(/Assistant chat failed \(500\).*nope/);
  });

  test("throws when the assistant returns an empty reply", async () => {
    installFetchMock([], () => Response.json({ response: "   " }));

    await expect(
      requestDeslopChat(transcript, {
        kind: "self-hosted",
        gatewayUrl: "http://127.0.0.1:7830",
        pairToken: "jwt",
      }),
    ).rejects.toThrow(/empty reply/);
  });
});
