import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ProxyApprovalCallback } from "../outbound-proxy/index.js";
import type { CredentialMetadata } from "../tools/credentials/metadata-store.js";
import type { CredentialInjectionTemplate } from "../tools/credentials/policy-types.js";
import type { ResolvedCredential } from "../tools/credentials/resolve.js";

// ── Mocks ────────────────────────────────────────────────────────────

let resolveByIdResults = new Map<string, ResolvedCredential | undefined>();
let credentialMetadataList: CredentialMetadata[] = [];

mock.module("../tools/credentials/resolve.js", () => ({
  resolveById: (credentialId: string) => resolveByIdResults.get(credentialId),
  resolveByServiceField: () => undefined,
  resolveForDomain: () => [],
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  listCredentialMetadata: () => credentialMetadataList,
}));

mock.module("../tools/network/script-proxy/certs.js", () => ({
  ensureLocalCA: async () => {},
  issueLeafCert: async () => ({ cert: "", key: "" }),
  getCAPath: (dataDir: string) => `${dataDir}/proxy-ca/ca.pem`,
}));

import {
  createSession,
  startSession,
  stopAllSessions,
  stopSession,
} from "../tools/network/script-proxy/session-manager.js";

let upstreamServer: Server | null = null;

afterEach(async () => {
  await stopAllSessions();
  resolveByIdResults = new Map();
  credentialMetadataList = [];
  if (upstreamServer) {
    await new Promise<void>((resolve) => {
      upstreamServer!.close(() => resolve());
    });
    upstreamServer = null;
  }
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
    storageKey: `credential:test-service:api-key`,
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

function startUpstream(
  responseBody: string,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(responseBody);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get upstream address"));
        return;
      }
      resolve({ server, port: addr.port });
    });
    server.on("error", reject);
  });
}

function proxyGet(
  proxyPort: number,
  targetUrl: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: proxyPort,
        path: targetUrl,
        method: "GET",
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("policy runtime enforcement", () => {
  const CONV_ID = "conv-policy-test";

  test("matched credential allows request (returns 200)", async () => {
    const upstream = await startUpstream("ok");
    upstreamServer = upstream.server;

    const resolved = makeResolved("cred-a", [makeTemplate("127.0.0.1")]);
    resolveByIdResults.set("cred-a", resolved);
    credentialMetadataList.push(resolved.metadata);

    const session = createSession(CONV_ID, ["cred-a"]);
    const started = await startSession(session.id);

    const response = await proxyGet(
      started.port!,
      `http://127.0.0.1:${upstream.port}/test`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toBe("ok");

    await stopSession(session.id);
  });

  test("missing credential (no allKnown match) allows pass-through as ask_unauthenticated", async () => {
    const upstream = await startUpstream("pass-through");
    upstreamServer = upstream.server;

    // Session credential has template for *.fal.ai, but request goes to 127.0.0.1.
    // The full registry also only has *.fal.ai, so no allKnown match for 127.0.0.1.
    // evaluateRequest => 'missing', allKnown check => no match => ask_unauthenticated.
    // Without approval callback, ask_unauthenticated => allow.
    const resolved = makeResolved("cred-a", [makeTemplate("*.fal.ai")]);
    resolveByIdResults.set("cred-a", resolved);
    credentialMetadataList.push(resolved.metadata);

    const session = createSession(CONV_ID, ["cred-a"]);
    const started = await startSession(session.id);

    const response = await proxyGet(
      started.port!,
      `http://127.0.0.1:${upstream.port}/test`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toBe("pass-through");
    await stopSession(session.id);
  });

  test("ambiguous credential blocks request (returns 403)", async () => {
    const upstream = await startUpstream("should-not-reach");
    upstreamServer = upstream.server;

    // Two credentials both match 127.0.0.1 — ambiguous decision
    const resolvedA = makeResolved("cred-a", [makeTemplate("127.0.0.1")]);
    const resolvedB = makeResolved("cred-b", [makeTemplate("127.0.0.1")]);
    resolveByIdResults.set("cred-a", resolvedA);
    resolveByIdResults.set("cred-b", resolvedB);
    credentialMetadataList.push(resolvedA.metadata, resolvedB.metadata);

    const session = createSession(CONV_ID, ["cred-a", "cred-b"]);
    const started = await startSession(session.id);

    const response = await proxyGet(
      started.port!,
      `http://127.0.0.1:${upstream.port}/test`,
    );
    expect(response.status).toBe(403);

    await stopSession(session.id);
  });

  test("unauthenticated session allows pass-through (returns 200)", async () => {
    const upstream = await startUpstream("pass-through");
    upstreamServer = upstream.server;

    // No credential IDs — unauthenticated pass-through
    const session = createSession(CONV_ID, []);
    const started = await startSession(session.id);

    const response = await proxyGet(
      started.port!,
      `http://127.0.0.1:${upstream.port}/test`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toBe("pass-through");

    await stopSession(session.id);
  });

  test("ask_missing_credential with approval callback: approved allows request", async () => {
    const upstream = await startUpstream("approved");
    upstreamServer = upstream.server;

    // Session has cred-a with template for *.fal.ai, but request goes to 127.0.0.1.
    // The global registry has cred-b with template for 127.0.0.1 (not in session).
    // evaluateRequest => 'missing' (session cred doesn't match 127.0.0.1).
    // allKnown includes 127.0.0.1 from cred-b => ask_missing_credential.
    // Approval callback returns true => allow.
    const resolvedA = makeResolved("cred-a", [makeTemplate("*.fal.ai")]);
    resolveByIdResults.set("cred-a", resolvedA);
    credentialMetadataList.push(resolvedA.metadata);

    // Add a credential to the global registry that matches 127.0.0.1 but is NOT in session
    const resolvedB = makeResolved("cred-b", [makeTemplate("127.0.0.1")]);
    credentialMetadataList.push(resolvedB.metadata);

    const approvalCallback: ProxyApprovalCallback = async () => true;
    const session = createSession(
      CONV_ID,
      ["cred-a"],
      undefined,
      undefined,
      approvalCallback,
    );

    const started = await startSession(session.id);

    const response = await proxyGet(
      started.port!,
      `http://127.0.0.1:${upstream.port}/test`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toBe("approved");

    await stopSession(session.id);
  });

  test("ask_unauthenticated with approval callback: denied blocks request", async () => {
    const upstream = await startUpstream("should-not-reach");
    upstreamServer = upstream.server;

    // Session has cred-a for *.fal.ai, request goes to 127.0.0.1.
    // Global registry has no template matching 127.0.0.1 => ask_unauthenticated.
    // Approval callback returns false => block.
    const resolvedA = makeResolved("cred-a", [makeTemplate("*.fal.ai")]);
    resolveByIdResults.set("cred-a", resolvedA);
    credentialMetadataList.push(resolvedA.metadata);

    const approvalCallback: ProxyApprovalCallback = async () => false;
    const session = createSession(
      CONV_ID,
      ["cred-a"],
      undefined,
      undefined,
      approvalCallback,
    );

    const started = await startSession(session.id);

    const response = await proxyGet(
      started.port!,
      `http://127.0.0.1:${upstream.port}/test`,
    );
    expect(response.status).toBe(403);

    await stopSession(session.id);
  });

  test("unauthenticated without approval callback allows pass-through", async () => {
    const upstream = await startUpstream("pass-through-no-cb");
    upstreamServer = upstream.server;

    // No credentials, no approval callback
    const session = createSession(CONV_ID, []);
    const started = await startSession(session.id);

    const response = await proxyGet(
      started.port!,
      `http://127.0.0.1:${upstream.port}/test`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toBe("pass-through-no-cb");

    await stopSession(session.id);
  });

  test("ask_unauthenticated without approval callback allows pass-through", async () => {
    const upstream = await startUpstream("no-callback-allow");
    upstreamServer = upstream.server;

    // Has credential IDs but no matching templates for the request host.
    // No approval callback — ask_unauthenticated defaults to allow.
    const resolved = makeResolved("cred-a", [makeTemplate("*.fal.ai")]);
    resolveByIdResults.set("cred-a", resolved);
    credentialMetadataList.push(resolved.metadata);

    const session = createSession(CONV_ID, ["cred-a"]);
    const started = await startSession(session.id);

    const response = await proxyGet(
      started.port!,
      `http://127.0.0.1:${upstream.port}/test`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toBe("no-callback-allow");

    await stopSession(session.id);
  });
});
