/**
 * Tests for the live-voice preflight route.
 *
 * The handler must run managed-speech defaulting first, then return the
 * live-voice credential readiness verdict verbatim:
 * - ready → { status: "ready" }
 * - not-ready → passes through the missing gaps + userMessage
 * - defaulting is invoked BEFORE readiness is resolved
 *
 * NOTE: `bun mock.module` leaks across files. Run this file on its own
 * (`bun test <thisfile>`) — a multi-file run may report a spurious failure.
 */

import { describe, expect, mock, test } from "bun:test";

import type { LiveVoiceCredentialReadiness } from "../../live-voice/live-voice-credential-preflight.js";

const calls: string[] = [];
let readiness: LiveVoiceCredentialReadiness = { status: "ready" };

mock.module("../../config/managed-speech-defaults.js", () => ({
  maybeDefaultSpeechToManaged: async () => {
    calls.push("default");
  },
}));

mock.module("../../live-voice/live-voice-credential-preflight.js", () => ({
  resolveLiveVoiceCredentialReadiness: async () => {
    calls.push("resolve");
    return readiness;
  },
}));

const { ROUTES } = await import("./live-voice-routes.js");

const preflightRoute = ROUTES.find(
  (r) => r.operationId === "live_voice_preflight_post",
)!;

describe("live_voice_preflight_post", () => {
  test("returns { status: 'ready' } when readiness reports ready", async () => {
    calls.length = 0;
    readiness = { status: "ready" };

    const result = await preflightRoute.handler({});

    expect(result).toEqual({ status: "ready" });
  });

  test("passes through the missing list and userMessage when not-ready", async () => {
    calls.length = 0;
    readiness = {
      status: "not-ready",
      missing: [
        { kind: "tts", providerId: "vellum", reason: "needs a connection" },
      ],
      userMessage: "Live voice is unavailable because it requires X.",
    };

    const result = await preflightRoute.handler({});

    expect(result).toEqual(readiness);
  });

  test("runs managed-speech defaulting before resolving readiness", async () => {
    calls.length = 0;
    readiness = { status: "ready" };

    await preflightRoute.handler({});

    expect(calls).toEqual(["default", "resolve"]);
  });
});
