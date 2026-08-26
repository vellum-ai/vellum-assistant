/**
 * Tests for `vellum gateway contacts` argument parsing and the
 * set-threshold HTTP write.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import type { AssistantEntry } from "../lib/assistant-config.js";

const fetchCalls: Array<{
  url: string;
  method?: string;
  body?: unknown;
}> = [];

let tokenExpiresAt = new Date(Date.now() + 60_000).toISOString();

mock.module("../lib/assistant-config.js", () => ({
  resolveTargetAssistant: () =>
    ({
      assistantId: "asst-1",
      localUrl: "http://127.0.0.1:7830",
    }) as AssistantEntry,
}));

mock.module("../lib/guardian-token.js", () => ({
  loadGuardianToken: () => ({
    accessToken: "guardian-token",
    accessTokenExpiresAt: tokenExpiresAt,
  }),
  refreshGuardianTokenResult: async () => ({
    ok: false,
    error: "refresh should not run",
  }),
}));

mock.module("../lib/loopback-fetch.js", () => ({
  loopbackSafeFetch: async (url: string, init?: RequestInit) => {
    let body: unknown;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    fetchCalls.push({ url, method: init?.method, body });
    const queued = fetchResponses.shift();
    if (!queued) {
      return new Response("{}", { status: 500 });
    }
    return queued;
  },
}));

const { executeGatewayContactsCommand, parseGatewayContactsArgs } =
  await import("../commands/gateway/contacts.js");

let fetchResponses: Response[] = [];

beforeEach(() => {
  fetchCalls.length = 0;
  fetchResponses = [];
  tokenExpiresAt = new Date(Date.now() + 60_000).toISOString();
});

afterEach(() => {
  fetchResponses = [];
});

describe("parseGatewayContactsArgs", () => {
  test("maps inherit to a null ceiling", () => {
    expect(
      parseGatewayContactsArgs([
        "set-threshold",
        "contact-1",
        "--threshold",
        "inherit",
      ]),
    ).toEqual({
      kind: "set-threshold",
      contactId: "contact-1",
      threshold: null,
      json: false,
    });
  });

  test("rejects an unknown threshold", () => {
    expect(
      parseGatewayContactsArgs([
        "set-threshold",
        "contact-1",
        "--threshold",
        "full",
      ]),
    ).toMatchObject({ kind: "error" });
  });
});

describe("vellum gateway contacts set-threshold", () => {
  test("reads the contact then POSTs the ceiling", async () => {
    fetchResponses.push(
      Response.json({
        ok: true,
        contact: { id: "contact-1", displayName: "Alice" },
      }),
    );
    fetchResponses.push(
      Response.json({
        ok: true,
        contact: {
          id: "contact-1",
          displayName: "Alice",
          autoApproveThreshold: "high",
        },
      }),
    );

    const logs: string[] = [];
    const log = console.log;
    console.log = (...parts: unknown[]) => {
      logs.push(parts.map(String).join(" "));
    };
    try {
      const code = await executeGatewayContactsCommand({
        kind: "set-threshold",
        contactId: "contact-1",
        threshold: "high",
        json: false,
      });
      expect(code).toBe(0);
    } finally {
      console.log = log;
    }

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7830/v1/contacts/contact-1");
    expect(fetchCalls[1]).toEqual({
      url: "http://127.0.0.1:7830/v1/contacts",
      method: "POST",
      body: {
        id: "contact-1",
        displayName: "Alice",
        autoApproveThreshold: "high",
      },
    });
    expect(logs.join("\n")).toContain(
      "Set assistant access for contact-1 to high",
    );
  });

  test("maps inherit to a null ceiling on POST", async () => {
    fetchResponses.push(
      Response.json({
        ok: true,
        contact: { id: "contact-1", displayName: "Alice" },
      }),
    );
    fetchResponses.push(
      Response.json({
        ok: true,
        contact: {
          id: "contact-1",
          displayName: "Alice",
          autoApproveThreshold: null,
        },
      }),
    );

    const log = console.log;
    console.log = () => {};
    try {
      const code = await executeGatewayContactsCommand({
        kind: "set-threshold",
        contactId: "contact-1",
        threshold: null,
        json: false,
      });
      expect(code).toBe(0);
    } finally {
      console.log = log;
    }

    expect(fetchCalls[1]?.body).toEqual({
      id: "contact-1",
      displayName: "Alice",
      autoApproveThreshold: null,
    });
  });

  test("maps a missing contact to exit 1", async () => {
    fetchResponses.push(new Response("{}", { status: 404 }));
    const errors: string[] = [];
    const error = console.error;
    console.error = (...parts: unknown[]) => {
      errors.push(parts.map(String).join(" "));
    };
    try {
      const code = await executeGatewayContactsCommand({
        kind: "set-threshold",
        contactId: "contact-missing",
        threshold: "high",
        json: false,
      });
      expect(code).toBe(1);
    } finally {
      console.error = error;
    }
    expect(errors.join("\n")).toContain("not found");
    expect(fetchCalls).toHaveLength(1);
  });
});
