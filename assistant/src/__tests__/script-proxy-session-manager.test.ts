import { afterEach, describe, expect, mock, test } from "bun:test";

import type { CredentialInjectionTemplate } from "../tools/credentials/policy-types.js";
import type { ResolvedCredential } from "../tools/credentials/resolve.js";

// ── Mocks ────────────────────────────────────────────────────────────

// Track resolveById return values per credential ID
let resolveByIdResults = new Map<string, ResolvedCredential | undefined>();

mock.module("../tools/credentials/resolve.js", () => ({
  resolveById: (credentialId: string) => resolveByIdResults.get(credentialId),
  resolveByServiceField: () => undefined,
  resolveForDomain: () => [],
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  listCredentialMetadata: () => [],
}));

// Stub ensureLocalCA so tests never run openssl
mock.module("../outbound-proxy/certs.js", () => ({
  ensureLocalCA: async () => {},
  ensureCombinedCABundle: async () => null,
  issueLeafCert: async () => ({ cert: "", key: "" }),
  getCAPath: (dataDir: string) => `${dataDir}/proxy-ca/ca.pem`,
  getCombinedCAPath: (dataDir: string) =>
    `${dataDir}/proxy-ca/combined-ca-bundle.pem`,
}));

import {
  createSession,
  getActiveSession,
  getSessionEnv,
  getSessionsForConversation,
  startSession,
  stopAllSessions,
  stopSession,
} from "../tools/network/script-proxy/session-manager.js";

afterEach(async () => {
  await stopAllSessions();
  resolveByIdResults = new Map();
});

function makeTemplate(
  hostPattern: string,
  headerName = "Authorization",
  valuePrefix = "Key ",
): CredentialInjectionTemplate {
  return { hostPattern, injectionType: "header", headerName, valuePrefix };
}

function makeResolved(
  credentialId: string,
  templates: CredentialInjectionTemplate[],
): ResolvedCredential {
  return {
    credentialId,
    service: "test-service",
    field: "api-key",
    storageKey: `credential/test-service/api-key`,
    injectionTemplates: templates,
    metadata: {
      credentialId,
      service: "test-service",
      field: "api-key",
      allowedTools: [],
      allowedDomains: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      injectionTemplates: templates,
    },
  };
}

describe("session-manager", () => {
  const CONV_ID = "conv-test-1";
  const CRED_IDS = ["cred-a", "cred-b"];

  describe("createSession", () => {
    test("creates a session in starting status with no port", () => {
      const session = createSession(CONV_ID, CRED_IDS);
      expect(session.id).toBeTruthy();
      expect(session.conversationId).toBe(CONV_ID);
      expect(session.credentialIds).toEqual(CRED_IDS);
      expect(session.status).toBe("starting");
      expect(session.port).toBeNull();
      expect(session.createdAt).toBeInstanceOf(Date);
    });

    test("generates unique IDs", () => {
      const a = createSession(CONV_ID, CRED_IDS);
      const b = createSession(CONV_ID, CRED_IDS);
      expect(a.id).not.toBe(b.id);
    });

    test("enforces maxSessionsPerConversation", () => {
      createSession(CONV_ID, CRED_IDS, { maxSessionsPerConversation: 1 });
      expect(() =>
        createSession(CONV_ID, CRED_IDS, { maxSessionsPerConversation: 1 }),
      ).toThrow(/Max sessions/);
    });

    test("does not count stopped sessions toward the limit", async () => {
      const s = createSession(CONV_ID, CRED_IDS, {
        maxSessionsPerConversation: 1,
      });
      await startSession(s.id);
      await stopSession(s.id);
      // Should succeed because the first session is now stopped
      const s2 = createSession(CONV_ID, CRED_IDS, {
        maxSessionsPerConversation: 1,
      });
      expect(s2.id).toBeTruthy();
    });
  });

  describe("startSession", () => {
    test("starts listening on an ephemeral port", async () => {
      const session = createSession(CONV_ID, CRED_IDS);
      const started = await startSession(session.id);
      expect(started.status).toBe("active");
      expect(started.port).toBeGreaterThan(0);
    });

    test("throws when session does not exist", async () => {
      await expect(startSession("nonexistent")).rejects.toThrow(/not found/);
    });

    test("throws when session is not in starting status", async () => {
      const session = createSession(CONV_ID, CRED_IDS);
      await startSession(session.id);
      await expect(startSession(session.id)).rejects.toThrow(
        /expected starting/,
      );
    });
  });

  describe("stopSession", () => {
    test("stops an active session", async () => {
      const session = createSession(CONV_ID, CRED_IDS);
      await startSession(session.id);
      await stopSession(session.id);

      const all = getSessionsForConversation(CONV_ID);
      const stopped = all.find((s) => s.id === session.id);
      expect(stopped?.status).toBe("stopped");
      expect(stopped?.port).toBeNull();
    });

    test("is idempotent for already-stopped sessions", async () => {
      const session = createSession(CONV_ID, CRED_IDS);
      await startSession(session.id);
      await stopSession(session.id);
      // Should not throw
      await stopSession(session.id);
    });

    test("throws for nonexistent session", async () => {
      await expect(stopSession("nonexistent")).rejects.toThrow(/not found/);
    });
  });

  describe("getSessionEnv", () => {
    test("returns proxy env vars for an active session", async () => {
      const session = createSession(CONV_ID, CRED_IDS);
      const started = await startSession(session.id);
      const env = getSessionEnv(session.id);

      expect(env.HTTP_PROXY).toBe(`http://127.0.0.1:${started.port}`);
      expect(env.HTTPS_PROXY).toBe(`http://127.0.0.1:${started.port}`);
      expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    });

    test("throws for inactive session", () => {
      const session = createSession(CONV_ID, CRED_IDS);
      expect(() => getSessionEnv(session.id)).toThrow(/not active/);
    });

    test("returns 127.0.0.1 URL for active session", async () => {
      const session = createSession(CONV_ID, CRED_IDS);
      const started = await startSession(session.id);
      const env = getSessionEnv(session.id);

      expect(env.HTTP_PROXY).toBe(`http://127.0.0.1:${started.port}`);
      expect(env.HTTPS_PROXY).toBe(`http://127.0.0.1:${started.port}`);
    });
  });

  describe("getActiveSession", () => {
    test("returns an active session for the conversation", async () => {
      const session = createSession(CONV_ID, CRED_IDS);
      await startSession(session.id);
      const active = getActiveSession(CONV_ID);
      expect(active).toBeDefined();
      expect(active!.id).toBe(session.id);
      expect(active!.status).toBe("active");
    });

    test("returns undefined when no active session exists", () => {
      expect(getActiveSession("nonexistent-conv")).toBeUndefined();
    });

    test("returns undefined after session is stopped", async () => {
      const session = createSession(CONV_ID, CRED_IDS);
      await startSession(session.id);
      await stopSession(session.id);
      expect(getActiveSession(CONV_ID)).toBeUndefined();
    });
  });

  describe("getSessionsForConversation", () => {
    test("returns all sessions for a conversation", async () => {
      createSession(CONV_ID, CRED_IDS);
      createSession(CONV_ID, ["cred-c"]);
      const all = getSessionsForConversation(CONV_ID);
      expect(all).toHaveLength(2);
    });

    test("does not include sessions from other conversations", () => {
      createSession(CONV_ID, CRED_IDS);
      createSession("other-conv", CRED_IDS);
      const all = getSessionsForConversation(CONV_ID);
      expect(all).toHaveLength(1);
    });
  });

  describe("stopAllSessions", () => {
    test("stops all active sessions", async () => {
      const a = createSession(CONV_ID, CRED_IDS);
      const b = createSession("conv-2", CRED_IDS);
      await startSession(a.id);
      await startSession(b.id);

      await stopAllSessions();

      // After stopAll + clear, no sessions should exist
      expect(getActiveSession(CONV_ID)).toBeUndefined();
      expect(getActiveSession("conv-2")).toBeUndefined();
    });
  });

  describe("idle timeout", () => {
    test("auto-stops session after idle timeout", async () => {
      const session = createSession(CONV_ID, CRED_IDS, { idleTimeoutMs: 100 });
      await startSession(session.id);
      expect(getActiveSession(CONV_ID)).toBeDefined();

      // Wait for the idle timeout to fire
      await new Promise((r) => setTimeout(r, 200));

      expect(getActiveSession(CONV_ID)).toBeUndefined();
      const all = getSessionsForConversation(CONV_ID);
      const s = all.find((x) => x.id === session.id);
      expect(s?.status).toBe("stopped");
    });
  });

  // ── MITM handler wiring tests ──────────────────────────────────────

  describe("MITM handler wiring", () => {
    const DATA_DIR = "/tmp/vellum-test-mitm";

    test("session without credential IDs creates proxy without MITM handler", async () => {
      // No credential IDs and no dataDir — plain tunnel proxy
      const session = createSession(CONV_ID, []);
      const started = await startSession(session.id);
      expect(started.status).toBe("active");
      expect(started.port).toBeGreaterThan(0);
    });

    test("session with credential IDs but no dataDir creates proxy without MITM handler", async () => {
      // Credential IDs present but no dataDir — MITM path is skipped
      resolveByIdResults.set(
        "cred-fal",
        makeResolved("cred-fal", [makeTemplate("*.fal.ai")]),
      );

      const session = createSession(CONV_ID, ["cred-fal"]);
      const started = await startSession(session.id);
      expect(started.status).toBe("active");
      expect(started.port).toBeGreaterThan(0);
    });

    test("session with credential IDs and dataDir creates proxy with MITM handler", async () => {
      resolveByIdResults.set(
        "cred-fal",
        makeResolved("cred-fal", [makeTemplate("*.fal.ai")]),
      );

      const session = createSession(CONV_ID, ["cred-fal"], undefined, DATA_DIR);
      const started = await startSession(session.id);
      expect(started.status).toBe("active");
      expect(started.port).toBeGreaterThan(0);
    });

    test("session with credential IDs that have no templates creates proxy without MITM", async () => {
      // resolveById returns a credential with no injection templates
      resolveByIdResults.set("cred-empty", makeResolved("cred-empty", []));

      const session = createSession(
        CONV_ID,
        ["cred-empty"],
        undefined,
        DATA_DIR,
      );
      const started = await startSession(session.id);
      expect(started.status).toBe("active");
      expect(started.port).toBeGreaterThan(0);
    });

    test("session with unresolvable credential IDs creates proxy without MITM", async () => {
      // resolveById returns undefined for unknown credentials
      const session = createSession(
        CONV_ID,
        ["cred-unknown"],
        undefined,
        DATA_DIR,
      );
      const started = await startSession(session.id);
      expect(started.status).toBe("active");
      expect(started.port).toBeGreaterThan(0);
    });
  });

  // ── shouldIntercept routing integration ────────────────────────────

  describe("MITM shouldIntercept routing", () => {
    // These tests verify that the session wires routeConnection correctly
    // by exercising the full create → start → CONNECT flow. We use a
    // lightweight approach: import routeConnection directly and verify
    // the templates map the session would build produces correct decisions.

    test("shouldIntercept returns mitm for credential-matched hosts", async () => {
      const { routeConnection } = await import("../outbound-proxy/index.js");

      const templates = new Map([["cred-fal", [makeTemplate("*.fal.ai")]]]);

      const decision = routeConnection(
        "api.fal.ai",
        443,
        ["cred-fal"],
        templates,
      );
      expect(decision.action).toBe("mitm");
      expect(decision.reason).toBe("mitm:credential_injection");
    });

    test("shouldIntercept returns tunnel for non-matching hosts", async () => {
      const { routeConnection } = await import("../outbound-proxy/index.js");

      const templates = new Map([["cred-fal", [makeTemplate("*.fal.ai")]]]);

      const decision = routeConnection(
        "api.openai.com",
        443,
        ["cred-fal"],
        templates,
      );
      expect(decision.action).toBe("tunnel");
      expect(decision.reason).toBe("tunnel:no_rewrite");
    });

    test("shouldIntercept returns tunnel when no credentials configured", async () => {
      const { routeConnection } = await import("../outbound-proxy/index.js");

      const decision = routeConnection("api.fal.ai", 443, [], new Map());
      expect(decision.action).toBe("tunnel");
      expect(decision.reason).toBe("tunnel:no_credentials");
    });
  });

  // ── Approval callback storage ──────────────────────────────────────

  describe("approval callback", () => {
    test("stores approval callback when provided", () => {
      const callback = async () => true;
      const session = createSession(
        CONV_ID,
        CRED_IDS,
        undefined,
        undefined,
        callback,
      );
      expect(session.id).toBeTruthy();
      expect(session.status).toBe("starting");
    });

    test("works without approval callback (undefined)", () => {
      const session = createSession(CONV_ID, CRED_IDS);
      expect(session.id).toBeTruthy();
      expect(session.status).toBe("starting");
    });

    test("works without approval callback (explicit undefined)", () => {
      const session = createSession(
        CONV_ID,
        CRED_IDS,
        undefined,
        undefined,
        undefined,
      );
      expect(session.id).toBeTruthy();
      expect(session.status).toBe("starting");
    });
  });
});
