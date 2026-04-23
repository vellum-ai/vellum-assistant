/**
 * Tests for `skills/meet-join/register.ts`.
 *
 * `register(host)` wires meet-join's tools and HTTP route into the
 * assistant via the host contract. Without it, the daemon's
 * `initializeTools()` never sees the meet tools and they remain
 * invisible to the LLM. These assertions guard that invariant — if a
 * meet tool is added / renamed / removed, this test catches the drift
 * before the tool silently disappears from production.
 *
 * Test strategy: build a fake `SkillHost` that captures every
 * registration call and pass it to `register(host)`. Module-level
 * side-effect imports of the tools and the meet-internal route are
 * mocked so that the tool objects and the path regex resolve without
 * pulling in the real assistant tool-registry / session-router module
 * graphs (which would force us to stand up SQLite, credential
 * storage, etc. just to assert a tool list).
 */

import type { SkillHost, Tool } from "@vellumai/skill-host-contracts";
import { afterAll, describe, expect, mock, test } from "bun:test";

// Stub the meet-internal route module so we can (a) assert the exact
// meetingId passed to the handler after URL decoding, and (b) avoid
// pulling in the real handler's transitive imports (session router,
// http-errors) during test boot. We re-declare the path regex here so
// register.ts still gets a usable value at the original export name.
let lastHandlerMeetingId: string | null = null;
mock.module("../routes/meet-internal.js", () => ({
  MEET_INTERNAL_EVENTS_PATH_RE: /^\/v1\/internal\/meet\/([^/]+)\/events$/,
  handleMeetInternalEvents: async (
    _host: SkillHost,
    _req: Request,
    meetingId: string,
  ) => {
    lastHandlerMeetingId = meetingId;
    return new Response(null, { status: 204 });
  },
}));

// The tool modules still import from `assistant/` until Wave 6 lands
// (PR 14). Mock the transitive imports they evaluate at load time so
// this test does not force the full daemon bootstrap.
mock.module("../../../assistant/src/tools/registry.js", () => ({
  registerExternalTools: () => {},
}));

mock.module("../../../assistant/src/runtime/skill-route-registry.js", () => ({
  registerSkillRoute: () => Object.freeze({}),
}));

mock.module("../../../assistant/src/config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
}));

mock.module("../../../assistant/src/config/loader.js", () => ({
  getConfig: () => ({}),
}));

// Stub the session manager — register.ts does not invoke it, but the
// meet tool modules import it at evaluation time, so the mock keeps
// module loading cheap and side-effect-free.
mock.module("../daemon/session-manager.js", () => ({
  MeetSessionManager: {
    activeSessions: () => [],
    getSession: () => null,
    join: async () => {
      throw new Error("join not used in register tests");
    },
    leave: async () => {},
    sendChat: async () => {},
    speak: async () => ({ streamId: "unused" }),
    cancelSpeak: async () => {},
    enableAvatar: async () => ({ enabled: true }),
    disableAvatar: async () => ({ disabled: true }),
  },
  MeetSessionNotFoundError: class extends Error {
    readonly name = "MeetSessionNotFoundError";
  },
  MeetSessionUnreachableError: class extends Error {
    readonly name = "MeetSessionUnreachableError";
  },
  MeetBotAvatarError: class extends Error {
    readonly name = "MeetBotAvatarError";
  },
  MeetBotChatError: class extends Error {
    readonly name = "MeetBotChatError";
  },
}));

mock.module("../meet-config.js", () => ({
  getMeetConfig: () => ({
    consentMessage: "test-consent",
  }),
}));

mock.module("../../../assistant/src/daemon/identity-helpers.js", () => ({
  getAssistantName: () => "TestAssistant",
}));

mock.module("../../../assistant/src/util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

type FakeRoute = {
  pattern: RegExp;
  methods: string[];
  handler: (req: Request, match: RegExpMatchArray) => Promise<Response>;
};

/**
 * Build a fake `SkillHost` that captures the two registration calls
 * `register()` makes. Every other facet is a throwing proxy so that
 * if `register.ts` ever reached outside its documented contract the
 * test would fail loudly instead of silently succeeding against a
 * half-stubbed host.
 */
function buildCaptureHost(flagEnabled: boolean): {
  host: SkillHost;
  toolProviders: Array<() => Tool[]>;
  routes: FakeRoute[];
} {
  const routes: FakeRoute[] = [];
  const toolProviders: Array<() => Tool[]> = [];

  const unreachable = (path: string): never => {
    throw new Error(
      `register.test: fake SkillHost facet ${path} was unexpectedly accessed`,
    );
  };
  const throwingProxy = (path: string) =>
    new Proxy({}, { get: (_t, p) => unreachable(`${path}.${String(p)}`) });

  const host: SkillHost = {
    logger: {
      get: () =>
        new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
    } as SkillHost["logger"],
    config: {
      isFeatureFlagEnabled: (key: string) =>
        key === "meet" ? flagEnabled : true,
      getSection: () => undefined,
    },
    identity: {
      getAssistantName: () => "TestAssistant",
      internalAssistantId: "self",
    },
    platform: throwingProxy("platform") as SkillHost["platform"],
    providers: throwingProxy("providers") as SkillHost["providers"],
    memory: throwingProxy("memory") as SkillHost["memory"],
    events: throwingProxy("events") as SkillHost["events"],
    registries: {
      registerTools: (provider) => {
        if (typeof provider !== "function") {
          // register.ts always passes a provider closure; an eager
          // array would bypass the flag-deferral intent of the
          // external-tool registry.
          throw new Error("register.test: expected lazy tool provider");
        }
        toolProviders.push(provider);
      },
      registerSkillRoute: (route) => {
        routes.push(route as FakeRoute);
        return Object.freeze({}) as never;
      },
      registerShutdownHook: () =>
        unreachable("registries.registerShutdownHook"),
    },
    speakers: throwingProxy("speakers") as SkillHost["speakers"],
  };

  return { host, toolProviders, routes };
}

const EXPECTED_TOOL_NAMES = [
  "meet_cancel_speak",
  "meet_disable_avatar",
  "meet_enable_avatar",
  "meet_join",
  "meet_leave",
  "meet_send_chat",
  "meet_speak",
];

const { register } = await import("../register.js");

afterAll(() => {
  mock.restore();
});

describe("meet-join register", () => {
  test("registers every meet_* tool when the meet flag is on", () => {
    const capture = buildCaptureHost(true);
    register(capture.host);

    const tools = capture.toolProviders.flatMap((p) => p());
    const registeredNames = tools
      .map((t: { name: string }) => t.name)
      .sort();
    for (const expected of EXPECTED_TOOL_NAMES) {
      expect(registeredNames).toContain(expected);
    }
    // Exactly 7 distinct meet_* tools are expected. A count mismatch
    // is a signal to update the plan and related tests, not to
    // silently accept the drift.
    const meetTools = registeredNames.filter((n) => n.startsWith("meet_"));
    expect(new Set(meetTools).size).toBe(EXPECTED_TOOL_NAMES.length);
  });

  test("tool provider returns an empty list when the meet flag is off", () => {
    // The lazy provider closure is what the daemon's tool manifest
    // resolves at `getExternalTools()` time, so the flag read must
    // deflect to `[]` when the flag is off — otherwise dormant tool
    // definitions leak into the LLM's manifest and the in-`execute()`
    // defensive flag checks become the only safety net.
    const capture = buildCaptureHost(false);
    register(capture.host);
    const tools = capture.toolProviders.flatMap((p) => p());
    expect(tools).toEqual([]);
  });

  test("registers the meet-internal POST route for bot ingress", () => {
    // Without this registration the bot's POST /v1/internal/meet/:id/events
    // request falls through to the daemon's JWT middleware, which
    // rejects the bot's opaque hex bearer token with
    // "malformed_token: expected 3 dot-separated parts".
    const capture = buildCaptureHost(true);
    register(capture.host);

    const route = capture.routes.find((r) =>
      r.pattern.test("/v1/internal/meet/abc123/events"),
    );
    expect(route).toBeDefined();
    expect(route?.methods).toEqual(["POST"]);
    const match = "/v1/internal/meet/abc123/events".match(route!.pattern);
    expect(match?.[1]).toBe("abc123");
  });

  test("meet-internal route handler URL-decodes the meetingId capture", async () => {
    const capture = buildCaptureHost(true);
    register(capture.host);

    const path = "/v1/internal/meet/abc%20123/events";
    const route = capture.routes.find((r) => r.pattern.test(path));
    expect(route).toBeDefined();
    const match = path.match(route!.pattern)!;
    const req = new Request(`http://host${path}`, { method: "POST" });
    await route!.handler(req, match);
    expect(lastHandlerMeetingId).toBe("abc 123");
  });

  test("meet-internal route handler returns 400 on malformed percent-encoding", async () => {
    // `%` without two trailing hex digits makes decodeURIComponent
    // throw URIError. Without the try/catch this surfaces pre-auth
    // and the daemon returns a 500; the handler must intercept and
    // return 400.
    const capture = buildCaptureHost(true);
    register(capture.host);

    const path = "/v1/internal/meet/abc%ZZ/events";
    const route = capture.routes.find((r) => r.pattern.test(path));
    expect(route).toBeDefined();
    const match = path.match(route!.pattern)!;
    lastHandlerMeetingId = null;
    const req = new Request(`http://host${path}`, { method: "POST" });
    const res = await route!.handler(req, match);
    expect(res.status).toBe(400);
    expect(lastHandlerMeetingId).toBeNull();
  });
});
