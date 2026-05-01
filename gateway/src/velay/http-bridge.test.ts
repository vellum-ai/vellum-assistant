import { Buffer } from "node:buffer";
import { afterEach, describe, expect, mock, test } from "bun:test";

import { VELAY_FRAME_TYPES, type VelayHttpRequestFrame } from "./protocol.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { bridgeVelayHttpRequest } = await import("./http-bridge.js");

afterEach(() => {
  fetchMock = mock(async () => new Response());
});

function makeFrame(
  overrides: Partial<VelayHttpRequestFrame> = {},
): VelayHttpRequestFrame {
  return {
    type: VELAY_FRAME_TYPES.httpRequest,
    request_id: "req-123",
    method: "POST",
    path: "/webhooks/example",
    headers: {},
    ...overrides,
  };
}

function base64(text: string): string {
  return Buffer.from(text).toString("base64");
}

function decodeBase64(body: string | undefined): string {
  return Buffer.from(body ?? "", "base64").toString("utf8");
}

describe("Velay HTTP bridge", () => {
  test("forwards JSON body frames to the gateway loopback listener", async () => {
    const captured: {
      url: string;
      method: string;
      body: string;
      headers: Headers;
    }[] = [];
    fetchMock = mock(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const req = input as Request;
        captured.push({
          url: req.url,
          method: req.method,
          body: await req.text(),
          headers: req.headers,
        });
        return Response.json({ ok: true });
      },
    );

    const response = await bridgeVelayHttpRequest(
      makeFrame({
        path: "/webhooks/example",
        headers: {
          "content-type": ["application/json"],
          connection: ["keep-alive"],
          host: ["public.example.com"],
          "x-webhook-id": ["evt-123"],
        },
        body_base64: base64(JSON.stringify({ message: "hello" })),
      }),
      "http://127.0.0.1:7830",
    );

    expect(response.status_code).toBe(200);
    expect(captured[0].url).toBe("http://127.0.0.1:7830/webhooks/example");
    expect(captured[0].method).toBe("POST");
    expect(captured[0].body).toBe('{"message":"hello"}');
    expect(captured[0].headers.get("content-type")).toBe("application/json");
    expect(captured[0].headers.get("host")).toBe("public.example.com");
    expect(captured[0].headers.get("x-webhook-id")).toBe("evt-123");
    expect(captured[0].headers.has("connection")).toBe(false);
  });

  test("preserves form bodies and raw query strings for Twilio webhook routes", async () => {
    const captured: { url: string; body: string; headers: Headers }[] = [];
    fetchMock = mock(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const req = input as Request;
        captured.push({
          url: req.url,
          body: await req.text(),
          headers: req.headers,
        });
        return new Response("<Response/>", {
          status: 200,
          headers: { "content-type": "text/xml" },
        });
      },
    );

    await bridgeVelayHttpRequest(
      makeFrame({
        path: "/webhooks/twilio/voice",
        raw_query: "callSessionId=session-123&redirect=%2Fnext%3Fx%3D1",
        headers: {
          "content-type": ["application/x-www-form-urlencoded"],
        },
        body_base64: base64("CallSid=CA123&From=%2B15550100&To=%2B15550101"),
      }),
      "http://127.0.0.1:7830/",
    );

    const expectedUrl =
      "http://127.0.0.1:7830/webhooks/twilio/voice" +
      "?callSessionId=session-123&redirect=%2Fnext%3Fx%3D1";
    expect(captured[0].url).toBe(expectedUrl);
    expect(captured[0].body).toBe(
      "CallSid=CA123&From=%2B15550100&To=%2B15550101",
    );
    expect(captured[0].headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  test("converts loopback responses back into Velay response frames", async () => {
    fetchMock = mock(async () => {
      const headers = new Headers({
        "content-type": "text/plain",
        "x-result": "preserved",
        connection: "keep-alive",
        "transfer-encoding": "chunked",
      });
      headers.append("set-cookie", "session=abc; Path=/; HttpOnly");
      headers.append("set-cookie", "prefs=dark; Path=/");
      return new Response("created", {
        status: 201,
        headers,
      });
    });

    const response = await bridgeVelayHttpRequest(
      makeFrame({ request_id: "req-response" }),
      "http://127.0.0.1:7830",
    );

    expect(response).toEqual({
      type: VELAY_FRAME_TYPES.httpResponse,
      request_id: "req-response",
      status_code: 201,
      headers: {
        "content-type": ["text/plain"],
        "set-cookie": ["session=abc; Path=/; HttpOnly", "prefs=dark; Path=/"],
        "x-result": ["preserved"],
      },
      body_base64: base64("created"),
    });
  });

  test("rejects unsafe absolute paths without contacting the loopback listener", async () => {
    fetchMock = mock(async () => {
      throw new Error("should not fetch");
    });

    const response = await bridgeVelayHttpRequest(
      makeFrame({ path: "https://example.com/webhooks/example" }),
      "http://127.0.0.1:7830",
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status_code).toBe(502);
    expect(decodeBase64(response.body_base64)).toBe('{"error":"Bad Gateway"}');
  });

  test("returns a 502 response frame when the body is not valid base64", async () => {
    const response = await bridgeVelayHttpRequest(
      makeFrame({ body_base64: "not base64" }),
      "http://127.0.0.1:7830",
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status_code).toBe(502);
  });

  test("returns a 502 response frame when loopback fetch fails", async () => {
    fetchMock = mock(async () => {
      throw new Error("connection refused");
    });

    const response = await bridgeVelayHttpRequest(
      makeFrame(),
      "http://127.0.0.1:7830",
    );

    expect(response.status_code).toBe(502);
    expect(response.request_id).toBe("req-123");
  });
});
