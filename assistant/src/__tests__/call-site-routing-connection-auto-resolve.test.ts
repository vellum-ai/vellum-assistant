/**
 * Verifies `CallSiteRoutingProvider` auto-resolves a connection for
 * connection-less profiles even when the resolved provider matches the
 * default provider's name.
 *
 * On platform-hosted installs the default transport rides the managed
 * (platform-billed) `vellum` connection while presenting the upstream
 * provider's name (e.g. "anthropic"). A BYOK profile `{provider:
 * "anthropic"}` with no explicit `provider_connection` must route through
 * the user's own connection when one exists — reusing the default on a bare
 * name match silently bills managed credits for a BYOK-intent profile.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import * as realDb from "../persistence/db-connection.js";
import * as realConnections from "../providers/inference/connections.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";
import { setConfig } from "./helpers/set-config.js";

let connectionRows: Array<Record<string, unknown>> = [];

mock.module("../providers/inference/connections.js", () => ({
  ...realConnections,
  listConnections: () => connectionRows,
}));

mock.module("../persistence/db-connection.js", () => ({
  ...realDb,
  getDb: () => ({}),
}));

const { CallSiteRoutingProvider } =
  await import("../providers/call-site-routing.js");

const DUMMY_MESSAGES: Message[] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
];

function makeProvider(name: string, onCall: () => void): Provider {
  return {
    name,
    async sendMessage(
      _messages: Message[],
      _options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      onCall();
      return {
        content: [{ type: "text", text: "ok" }],
        model: name,
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

const PERSONAL_CONNECTION = {
  name: "anthropic-personal",
  provider: "anthropic",
  auth: { type: "api_key", credential: "credential/anthropic/api_key" },
};

beforeEach(() => {
  connectionRows = [];
  // Same provider name as the default transport; no provider_connection on
  // the profile — the managed-install shape that must not silently reuse
  // the default transport.
  setConfig("llm", {
    default: {
      provider: "anthropic",
      model: "claude-opus-4-8",
      provider_connection: "vellum",
    },
    profiles: {
      byok: { provider: "anthropic", model: "claude-fable-5" },
    },
    callSites: {
      memoryRetrieval: { profile: "byok" },
    },
  });
});

describe("CallSiteRoutingProvider connection auto-resolve", () => {
  test("routes a connection-less same-provider profile through the user's own connection", async () => {
    connectionRows = [PERSONAL_CONNECTION];

    const calls = { default: 0, personal: 0 };
    const defaultProvider = makeProvider("anthropic", () => {
      calls.default++;
    });
    const personalProvider = makeProvider("anthropic", () => {
      calls.personal++;
    });

    const resolvedNames: string[] = [];
    const wrapped = new CallSiteRoutingProvider(
      defaultProvider,
      async (connectionName: string) => {
        resolvedNames.push(connectionName);
        return connectionName === "anthropic-personal"
          ? personalProvider
          : null;
      },
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "memoryRetrieval" },
    });

    expect(resolvedNames).toEqual(["anthropic-personal"]);
    expect(calls.personal).toBe(1);
    expect(calls.default).toBe(0);
  });

  test("reuses the default transport when no connection exists for the provider", async () => {
    connectionRows = [];

    const calls = { default: 0 };
    const defaultProvider = makeProvider("anthropic", () => {
      calls.default++;
    });

    const resolvedNames: string[] = [];
    const wrapped = new CallSiteRoutingProvider(
      defaultProvider,
      async (connectionName: string) => {
        resolvedNames.push(connectionName);
        return null;
      },
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "memoryRetrieval" },
    });

    expect(resolvedNames).toEqual([]);
    expect(calls.default).toBe(1);
  });

  test("falls back to the default transport when the auto-resolved connection soft-fails", async () => {
    connectionRows = [PERSONAL_CONNECTION];

    const calls = { default: 0 };
    const defaultProvider = makeProvider("anthropic", () => {
      calls.default++;
    });

    const wrapped = new CallSiteRoutingProvider(
      defaultProvider,
      async () => null,
    );

    await wrapped.sendMessage(DUMMY_MESSAGES, {
      config: { callSite: "memoryRetrieval" },
    });

    expect(calls.default).toBe(1);
  });
});
