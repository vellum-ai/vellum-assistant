import * as http from "node:http";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ResolvedCredential } from "../tools/credentials/resolve.js";

let resolveByIdResults = new Map<string, ResolvedCredential | undefined>();
let secureKeyValues = new Map<string, string | undefined>();
let providerProfiles = new Map<
  string,
  { injectionTemplates?: Array<Record<string, string>> }
>();

mock.module("../tools/credentials/resolve.js", () => ({
  resolveById: (credentialId: string) => resolveByIdResults.get(credentialId),
  resolveByServiceField: () => undefined,
  resolveForDomain: () => [],
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  listCredentialMetadata: () => [],
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (account: string) => secureKeyValues.get(account),
  setSecureKey: () => true,
  deleteSecureKey: () => "deleted",
  listSecureKeys: () => [],
  getBackendType: () => "encrypted",
  _resetBackend: () => {},
  _setBackend: () => {},
}));

mock.module("../oauth/provider-profiles.js", () => ({
  getProviderProfile: (service: string) => providerProfiles.get(service),
}));

import {
  createSession,
  startSession,
  stopAllSessions,
} from "../tools/network/script-proxy/session-manager.js";

afterEach(async () => {
  await stopAllSessions();
  resolveByIdResults = new Map();
  secureKeyValues = new Map();
  providerProfiles = new Map();
});

function proxyRequest(port: number, targetUrl: string): Promise<number> {
  return new Promise<number>((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: targetUrl,
        method: "GET",
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", () => resolve(-1));
    req.end();
  });
}

describe("script proxy profile-template fallback", () => {
  test("falls back to provider profile templates for access_token credentials", async () => {
    let receivedHeaders: http.IncomingHttpHeaders = {};
    const echo = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const echoPort = (echo.address() as { port: number }).port;

    try {
      providerProfiles.set("integration:gmail", {
        injectionTemplates: [
          {
            hostPattern: "127.0.0.1",
            injectionType: "header",
            headerName: "Authorization",
            valuePrefix: "Bearer ",
          },
        ],
      });

      resolveByIdResults.set("cred-gmail", {
        credentialId: "cred-gmail",
        service: "integration:gmail",
        field: "access_token",
        storageKey: "credential:integration:gmail:access_token",
        injectionTemplates: [],
        metadata: {
          credentialId: "cred-gmail",
          service: "integration:gmail",
          field: "access_token",
          allowedTools: [],
          allowedDomains: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });
      secureKeyValues.set(
        "credential:integration:gmail:access_token",
        "gmail_token_123",
      );

      const session = createSession("conv-fallback", ["cred-gmail"]);
      const started = await startSession(session.id);

      const status = await proxyRequest(
        started.port!,
        `http://127.0.0.1:${echoPort}/v1/test`,
      );

      expect(status).toBe(200);
      expect(receivedHeaders["authorization"]).toBe("Bearer gmail_token_123");
    } finally {
      echo.close();
    }
  });
});
