import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { channelPolicy } from "../commands/channel-policy.js";
import { type AssistantEntry } from "../lib/assistant-config.js";

const testDir = mkdtempSync(join(tmpdir(), "cli-channel-policy-test-"));
const originalArgv = [...process.argv];
const originalExit = process.exit;
const originalFetch = globalThis.fetch;
const originalLockfileDir = process.env.VELLUM_LOCKFILE_DIR;

let consoleLogSpy: ReturnType<typeof spyOn>;
let consoleErrorSpy: ReturnType<typeof spyOn>;
let consoleWarnSpy: ReturnType<typeof spyOn>;
let fetchCalls: Array<{ url: string; method: string; body?: string }>;
type Responder = (url: string, init?: RequestInit) => Response;
let responder: Responder;

function makeEntry(assistantId: string): AssistantEntry {
  return {
    assistantId,
    runtimeUrl: "http://127.0.0.1:7900",
    cloud: "local",
  };
}

function writeLockfile(entries: AssistantEntry[], active?: string): void {
  mkdirSync(testDir, { recursive: true });
  writeFileSync(
    join(testDir, ".vellum.lock.json"),
    JSON.stringify(
      {
        assistants: entries,
        ...(active ? { activeAssistant: active } : {}),
      },
      null,
      2,
    ),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("vellum channel-policy", () => {
  beforeEach(() => {
    process.env.VELLUM_LOCKFILE_DIR = testDir;
    rmSync(join(testDir, ".vellum.lock.json"), { force: true });
    fetchCalls = [];
    responder = () => jsonResponse({ policies: [] });
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : undefined;
      fetchCalls.push({ url, method, body });
      return responder(url, init);
    }) as typeof globalThis.fetch;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit;
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});

    writeLockfile([makeEntry("alpha-1")], "alpha-1");
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    globalThis.fetch = originalFetch;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  afterAll(() => {
    if (originalLockfileDir === undefined) {
      delete process.env.VELLUM_LOCKFILE_DIR;
    } else {
      process.env.VELLUM_LOCKFILE_DIR = originalLockfileDir;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  test("list omits internal channels even if the gateway returns them", async () => {
    // §8.1: vellum/platform/a2a are internal and must never appear in client
    // UI/CLI. The gateway is the source of truth but the CLI double-filters
    // so a future gateway regression can't leak them.
    responder = () =>
      jsonResponse({
        policies: [
          {
            channelType: "slack",
            policy: "trusted_contacts",
            note: null,
            updatedAt: null,
          },
          {
            channelType: "vellum",
            policy: "trusted_contacts",
            note: null,
            updatedAt: null,
          },
          {
            channelType: "platform",
            policy: "trusted_contacts",
            note: null,
            updatedAt: null,
          },
          {
            channelType: "a2a",
            policy: "trusted_contacts",
            note: null,
            updatedAt: null,
          },
          {
            channelType: "email",
            policy: "guardian_only",
            note: "stricter",
            updatedAt: 123,
          },
        ],
      });

    process.argv = ["bun", "vellum", "channel-policy", "list"];
    await channelPolicy();

    const printed = consoleLogSpy.mock.calls
      .map((c: unknown[]) => String(c[0] ?? ""))
      .join("\n");
    expect(printed).toContain("slack");
    expect(printed).toContain("email");
    expect(printed).not.toContain("vellum");
    expect(printed).not.toContain("platform");
    expect(printed).not.toContain("a2a");
  });

  test("set writes the floor via POST to the flat route", async () => {
    responder = () =>
      jsonResponse({
        policy: {
          channelType: "slack",
          policy: "guardian_only",
          note: null,
          updatedAt: Date.now(),
        },
      });

    process.argv = [
      "bun",
      "vellum",
      "channel-policy",
      "set",
      "slack",
      "guardian_only",
    ];
    await channelPolicy();

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].method).toBe("POST");
    expect(fetchCalls[0].url).toContain(
      "/v1/assistants/alpha-1/channel-admission-policy/slack",
    );
    expect(fetchCalls[0].body).toBe(
      JSON.stringify({ policy: "guardian_only" }),
    );
  });

  test("set rejects unknown floor values", async () => {
    process.argv = [
      "bun",
      "vellum",
      "channel-policy",
      "set",
      "slack",
      "totally_made_up",
    ];
    await expect(channelPolicy()).rejects.toThrow(/process\.exit:1/);
    expect(fetchCalls.length).toBe(0);
    const err = consoleErrorSpy.mock.calls
      .map((c: unknown[]) => String(c[0] ?? ""))
      .join("\n");
    expect(err).toContain("Invalid floor");
  });

  test("set on an internal channel refuses without calling the gateway", async () => {
    // §8.1 enforcement in the CLI: refuse client-side so the user gets a
    // clear message instead of a server-side 403. The gateway also enforces
    // this; the CLI is just being a good citizen.
    process.argv = [
      "bun",
      "vellum",
      "channel-policy",
      "set",
      "vellum",
      "no_one",
    ];
    await expect(channelPolicy()).rejects.toThrow(/process\.exit:1/);
    expect(fetchCalls.length).toBe(0);
    const err = consoleErrorSpy.mock.calls
      .map((c: unknown[]) => String(c[0] ?? ""))
      .join("\n");
    expect(err).toContain("internal");
  });

  test("set surfaces a 403 from the gateway", async () => {
    responder = () =>
      jsonResponse({ error: "forbidden" }, 403);

    process.argv = [
      "bun",
      "vellum",
      "channel-policy",
      "set",
      "email",
      "no_one",
    ];
    await expect(channelPolicy()).rejects.toThrow(/process\.exit:1/);
    const err = consoleErrorSpy.mock.calls
      .map((c: unknown[]) => String(c[0] ?? ""))
      .join("\n");
    expect(err).toContain("403");
  });

  test("conversation-set warns when override is less restrictive than type floor", async () => {
    // §8.3: lowering the floor for a single conversation admits more
    // senders than the channel-type default. The CLI must call this out so
    // a guardian doesn't quietly widen their inbound surface.
    responder = (_url, init) => {
      const sent = JSON.parse(String(init?.body ?? "{}")) as { floor?: string };
      return jsonResponse({
        override: {
          conversationId: "slack:C0123",
          channelType: "slack",
          override: sent.floor ?? null,
          typeFloor: "guardian_only",
          updatedAt: Date.now(),
        },
      });
    };

    process.argv = [
      "bun",
      "vellum",
      "channel-policy",
      "conversation-set",
      "slack:C0123",
      "trusted_contacts",
    ];
    await channelPolicy();

    const warned = consoleWarnSpy.mock.calls
      .map((c: unknown[]) => String(c[0] ?? ""))
      .join("\n");
    expect(warned).toContain("default is guardian_only");
    expect(warned).toContain("trusted_contacts");
  });

  test("conversation-set does NOT warn when override matches type floor", async () => {
    responder = (_url, init) => {
      const sent = JSON.parse(String(init?.body ?? "{}")) as { floor?: string };
      return jsonResponse({
        override: {
          conversationId: "slack:C0123",
          channelType: "slack",
          override: sent.floor ?? null,
          typeFloor: "trusted_contacts",
          updatedAt: Date.now(),
        },
      });
    };

    process.argv = [
      "bun",
      "vellum",
      "channel-policy",
      "conversation-set",
      "slack:C0123",
      "trusted_contacts",
    ];
    await channelPolicy();

    expect(consoleWarnSpy.mock.calls.length).toBe(0);
  });

  test("conversation-list reports current override and type floor", async () => {
    responder = () =>
      jsonResponse({
        override: {
          conversationId: "slack:C0123",
          channelType: "slack",
          override: null,
          typeFloor: "trusted_contacts",
          updatedAt: null,
        },
      });

    process.argv = [
      "bun",
      "vellum",
      "channel-policy",
      "conversation-list",
      "slack:C0123",
    ];
    await channelPolicy();

    const printed = consoleLogSpy.mock.calls
      .map((c: unknown[]) => String(c[0] ?? ""))
      .join("\n");
    expect(printed).toContain("slack:C0123");
    expect(printed).toContain("trusted_contacts");
    expect(printed).toContain("inherits type floor");
  });
});
