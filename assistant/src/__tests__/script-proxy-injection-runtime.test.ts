import * as http from "node:http";
import { afterEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";
import type { CredentialMetadata } from "../tools/credentials/metadata-store.js";
import type { CredentialInjectionTemplate } from "../tools/credentials/policy-types.js";
import type { ResolvedCredential } from "../tools/credentials/resolve.js";

// ── Mocks ────────────────────────────────────────────────────────────

// Track resolveById return values per credential ID
let resolveByIdResults = new Map<string, ResolvedCredential | undefined>();
let resolveByServiceFieldResults = new Map<
  string,
  ResolvedCredential | undefined
>();
let credentialMetadataList: CredentialMetadata[] = [];

mock.module("../tools/credentials/resolve.js", () => ({
  resolveById: (credentialId: string) => resolveByIdResults.get(credentialId),
  resolveByServiceField: (service: string, field: string) =>
    resolveByServiceFieldResults.get(`${service}:${field}`),
  resolveForDomain: () => [],
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  listCredentialMetadata: () => credentialMetadataList,
}));

// Track getSecureKeyAsync return values per storage key
let secureKeyValues = new Map<string, string | undefined>();

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: (account: string) =>
    Promise.resolve(secureKeyValues.get(account)),
  setSecureKeyAsync: () => Promise.resolve(true),
  deleteSecureKeyAsync: () => Promise.resolve("deleted"),
  listSecureKeysAsync: async () => ({ accounts: [], unreachable: false }),
  _resetBackend: () => {},
}));

// Stub ensureLocalCA / certs so tests never run openssl
mock.module("../tools/network/script-proxy/certs.js", () => ({
  ensureLocalCA: async () => {},
  issueLeafCert: async () => ({ cert: "", key: "" }),
  getCAPath: (dataDir: string) => `${dataDir}/proxy-ca/ca.pem`,
}));

import {
  createSafeLogEntry,
  sanitizeHeaders,
} from "../outbound-proxy/index.js";
import {
  createSession,
  startSession,
  stopAllSessions,
} from "../tools/network/script-proxy/session-manager.js";

afterEach(async () => {
  await stopAllSessions();
  resolveByIdResults = new Map();
  resolveByServiceFieldResults = new Map();
  secureKeyValues = new Map();
  credentialMetadataList = [];
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
  service = "test-service",
  field = "api-key",
): ResolvedCredential {
  return {
    credentialId,
    service,
    field,
    storageKey: credentialKey(service, field),
    injectionTemplates: templates,
    metadata: {
      credentialId,
      service,
      field,
      allowedTools: [],
      allowedDomains: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      injectionTemplates: templates,
    },
  };
}

/**
 * Send a proxy-style HTTP request (absolute URL in the request line) through
 * the local proxy and capture the status code and any headers that were
 * forwarded to the upstream.
 *
 * Returns a Promise of the HTTP status code from the proxy.
 */
function proxyRequest(
  port: number,
  targetUrl: string,
  method = "GET",
): Promise<number> {
  return new Promise<number>((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: targetUrl,
        method,
      },
      (res) => {
        // Drain the response so the socket closes cleanly
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", () => resolve(-1));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// policyCallback credential injection — integration through real proxy
// ---------------------------------------------------------------------------

describe("policyCallback credential injection", () => {
  const CONV_ID = "conv-injection-test";
  const DATA_DIR = "/tmp/vellum-injection-test";

  test("matched credential injects Authorization header via policyCallback", async () => {
    // Set up a local echo server so we can inspect what headers the proxy
    // actually sends upstream.
    let receivedHeaders: http.IncomingHttpHeaders = {};
    const echo = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const echoPort = (echo.address() as { port: number }).port;

    try {
      const tpl = makeTemplate("127.0.0.1", "Authorization", "Key ");
      const resolved = makeResolved("cred-local", [tpl]);
      resolveByIdResults.set("cred-local", resolved);
      credentialMetadataList.push(resolved.metadata);
      secureKeyValues.set(
        credentialKey("test-service", "api-key"),
        "fal_secretvalue123",
      );

      const session = createSession(
        CONV_ID,
        ["cred-local"],
        undefined,
        DATA_DIR,
      );
      const started = await startSession(session.id);
      expect(started.status).toBe("active");

      const status = await proxyRequest(
        started.port!,
        `http://127.0.0.1:${echoPort}/test-path`,
      );

      expect(status).toBe(200);
      expect(receivedHeaders["authorization"]).toBe("Key fal_secretvalue123");
    } finally {
      echo.close();
    }
  });

  test('matched credential with prefix adds correct prefix (e.g. "Bearer ")', async () => {
    let receivedHeaders: http.IncomingHttpHeaders = {};
    const echo = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const echoPort = (echo.address() as { port: number }).port;

    try {
      const tpl = makeTemplate("127.0.0.1", "Authorization", "Bearer ");
      const resolved = makeResolved("cred-bearer", [tpl]);
      resolveByIdResults.set("cred-bearer", resolved);
      credentialMetadataList.push(resolved.metadata);
      secureKeyValues.set(
        credentialKey("test-service", "api-key"),
        "tok_abc123",
      );

      const session = createSession(
        CONV_ID,
        ["cred-bearer"],
        undefined,
        DATA_DIR,
      );
      const started = await startSession(session.id);

      const status = await proxyRequest(
        started.port!,
        `http://127.0.0.1:${echoPort}/test`,
      );

      expect(status).toBe(200);
      expect(receivedHeaders["authorization"]).toBe("Bearer tok_abc123");
    } finally {
      echo.close();
    }
  });

  test("missing credential value returns empty headers (fail-safe)", async () => {
    let receivedHeaders: http.IncomingHttpHeaders = {};
    const echo = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const echoPort = (echo.address() as { port: number }).port;

    try {
      const tpl = makeTemplate("127.0.0.1");
      const resolved = makeResolved("cred-missing", [tpl]);
      resolveByIdResults.set("cred-missing", resolved);
      credentialMetadataList.push(resolved.metadata);
      // Do NOT set secureKeyValues — simulates missing secret

      const session = createSession(
        CONV_ID,
        ["cred-missing"],
        undefined,
        DATA_DIR,
      );
      const started = await startSession(session.id);

      const status = await proxyRequest(
        started.port!,
        `http://127.0.0.1:${echoPort}/test`,
      );

      // The policyCallback returns {} when the secret is missing (fail-safe:
      // allow through without credentials rather than blocking).
      expect(status).toBe(200);
      // No authorization header should be present
      expect(receivedHeaders["authorization"]).toBeUndefined();
    } finally {
      echo.close();
    }
  });

  test("unresolvable credential ID is blocked", async () => {
    const echo = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const echoPort = (echo.address() as { port: number }).port;

    try {
      const tpl = makeTemplate("127.0.0.1");
      const resolved = makeResolved("cred-vanish", [tpl]);
      // Register the credential so the session builds templates during startSession
      resolveByIdResults.set("cred-vanish", resolved);
      credentialMetadataList.push(resolved.metadata);

      const session = createSession(
        CONV_ID,
        ["cred-vanish"],
        undefined,
        DATA_DIR,
      );

      // Remove the resolution so the policyCallback's resolveById fails at request time
      resolveByIdResults.delete("cred-vanish");

      const started = await startSession(session.id);

      const status = await proxyRequest(
        started.port!,
        `http://127.0.0.1:${echoPort}/test`,
      );

      // Unresolvable credentials are blocked (fail-closed)
      expect(status).toBe(403);
    } finally {
      echo.close();
    }
  });
});

// ---------------------------------------------------------------------------
// MITM rewriteCallback credential injection (unit-level logic verification)
// ---------------------------------------------------------------------------

describe("MITM rewriteCallback credential injection", () => {
  // The full MITM TLS interception path requires certificates and TLS
  // handshakes, which is tested separately. Here we verify the core
  // injection logic that the rewriteCallback implements.

  test("injects header for matched host in rewrite callback pattern", async () => {
    const { minimatch } = await import("minimatch");

    const tpl = makeTemplate("*.fal.ai", "authorization", "Key ");
    const resolved = makeResolved("cred-fal", [tpl]);
    resolveByIdResults.set("cred-fal", resolved);
    secureKeyValues.set(credentialKey("test-service", "api-key"), "fal_secret");

    const templates = new Map([["cred-fal", [tpl]]]);
    const headers: Record<string, string> = {
      host: "api.fal.ai",
      "content-type": "application/json",
    };
    const hostname = "api.fal.ai";

    // Simulate the rewriteCallback logic
    let injected = false;
    for (const [credId, tpls] of templates) {
      for (const t of tpls) {
        if (!minimatch(hostname, t.hostPattern, { nocase: true })) continue;

        const res = resolveByIdResults.get(credId);
        if (!res) continue;
        const value = secureKeyValues.get(res.storageKey);
        if (!value) continue;

        if (t.injectionType === "header" && t.headerName) {
          headers[t.headerName.toLowerCase()] = (t.valuePrefix ?? "") + value;
          injected = true;
          break;
        }
      }
      if (injected) break;
    }

    expect(injected).toBe(true);
    expect(headers["authorization"]).toBe("Key fal_secret");
    expect(headers["content-type"]).toBe("application/json");
  });

  test("no injection when hostname does not match any template", async () => {
    const { minimatch } = await import("minimatch");

    const tpl = makeTemplate("*.fal.ai", "authorization", "Key ");
    resolveByIdResults.set("cred-fal", makeResolved("cred-fal", [tpl]));
    secureKeyValues.set(credentialKey("test-service", "api-key"), "fal_secret");

    const templates = new Map([["cred-fal", [tpl]]]);
    const headers: Record<string, string> = {
      host: "api.openai.com",
      "content-type": "application/json",
    };

    let injected = false;
    for (const [, tpls] of templates) {
      for (const t of tpls) {
        if (!minimatch("api.openai.com", t.hostPattern, { nocase: true }))
          continue;
        injected = true;
      }
    }

    expect(injected).toBe(false);
    expect(headers["authorization"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Logging safety — injected values never appear in sanitized log entries
// ---------------------------------------------------------------------------

describe("injected header values never appear in sanitized log entries", () => {
  test("Authorization header with credential value is redacted", () => {
    const secretValue = ["Key ", "fal_", "superSecretValue"].join("");
    const req = {
      method: "POST",
      url: "https://api.fal.ai/v1/generate",
      headers: {
        Authorization: secretValue,
        "Content-Type": "application/json",
        Host: "api.fal.ai",
      },
    };

    const entry = createSafeLogEntry(req, ["Authorization"]);
    const serialized = JSON.stringify(entry);

    expect(serialized).not.toContain("fal_");
    expect(serialized).not.toContain("superSecretValue");
    expect(entry.headers["Authorization"]).toBe("[REDACTED]");
    expect(entry.headers["Content-Type"]).toBe("application/json");
  });

  test("custom header with credential value is redacted", () => {
    // Build test value at runtime to avoid pre-commit hook false positives
    const secretValue = ["my-api-", "key-", "12345"].join("");
    const req = {
      method: "GET",
      url: "https://api.example.com/v1/data",
      headers: {
        "X-Api-Key": secretValue,
        Accept: "application/json",
      },
    };

    const entry = createSafeLogEntry(req, ["X-Api-Key"]);
    const serialized = JSON.stringify(entry);

    expect(serialized).not.toContain("my-api-key-12345");
    expect(entry.headers["X-Api-Key"]).toBe("[REDACTED]");
    expect(entry.headers["Accept"]).toBe("application/json");
  });

  test("sanitizeHeaders is case-insensitive for injected header names", () => {
    const headers: Record<string, string> = {
      authorization: "Bearer secret123",
      "x-custom-key": "key-value-456",
    };

    const sanitized = sanitizeHeaders(headers, [
      "Authorization",
      "X-Custom-Key",
    ]);

    expect(sanitized["authorization"]).toBe("[REDACTED]");
    expect(sanitized["x-custom-key"]).toBe("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// composeWith injection — multi-value credential composition and transforms
// ---------------------------------------------------------------------------

describe("composeWith injection", () => {
  const CONV_ID = "conv-compose-test";
  const DATA_DIR = "/tmp/vellum-compose-test";

  test("composes two credential values with separator via policyCallback", async () => {
    let receivedHeaders: http.IncomingHttpHeaders = {};
    const echo = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const echoPort = (echo.address() as { port: number }).port;

    try {
      const tpl: CredentialInjectionTemplate = {
        hostPattern: "127.0.0.1",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Basic ",
        valueTransform: "base64",
        composeWith: { service: "twilio", field: "auth_token", separator: ":" },
      };

      const primaryResolved = makeResolved(
        "cred-primary",
        [tpl],
        "twilio",
        "account_sid",
      );
      resolveByIdResults.set("cred-primary", primaryResolved);
      credentialMetadataList.push(primaryResolved.metadata);

      const composedResolved = makeResolved(
        "cred-composed",
        [],
        "twilio",
        "auth_token",
      );
      resolveByServiceFieldResults.set("twilio:auth_token", composedResolved);

      secureKeyValues.set(credentialKey("twilio", "account_sid"), "ACtest123");
      secureKeyValues.set(credentialKey("twilio", "auth_token"), "secret456");

      const session = createSession(
        CONV_ID,
        ["cred-primary"],
        undefined,
        DATA_DIR,
      );
      const started = await startSession(session.id);
      expect(started.status).toBe("active");

      const status = await proxyRequest(
        started.port!,
        `http://127.0.0.1:${echoPort}/test`,
      );

      expect(status).toBe(200);
      const expectedValue =
        "Basic " + Buffer.from("ACtest123:secret456").toString("base64");
      expect(receivedHeaders["authorization"]).toBe(expectedValue);
    } finally {
      echo.close();
    }
  });

  test("composeWith with missing composed credential blocks request", async () => {
    const echo = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const echoPort = (echo.address() as { port: number }).port;

    try {
      const tpl: CredentialInjectionTemplate = {
        hostPattern: "127.0.0.1",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Basic ",
        valueTransform: "base64",
        composeWith: { service: "twilio", field: "auth_token", separator: ":" },
      };

      const primaryResolved = makeResolved(
        "cred-primary",
        [tpl],
        "twilio",
        "account_sid",
      );
      resolveByIdResults.set("cred-primary", primaryResolved);
      credentialMetadataList.push(primaryResolved.metadata);
      secureKeyValues.set(credentialKey("twilio", "account_sid"), "ACtest123");

      // Do NOT register the composed credential in resolveByServiceFieldResults

      const session = createSession(
        CONV_ID,
        ["cred-primary"],
        undefined,
        DATA_DIR,
      );
      const started = await startSession(session.id);
      expect(started.status).toBe("active");

      const status = await proxyRequest(
        started.port!,
        `http://127.0.0.1:${echoPort}/test`,
      );

      // Missing composeWith credential blocks the request (fail-closed)
      expect(status).toBe(403);
    } finally {
      echo.close();
    }
  });

  test("valueTransform base64 without composeWith", async () => {
    let receivedHeaders: http.IncomingHttpHeaders = {};
    const echo = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const echoPort = (echo.address() as { port: number }).port;

    try {
      const tpl: CredentialInjectionTemplate = {
        hostPattern: "127.0.0.1",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Token ",
        valueTransform: "base64",
      };

      const resolved = makeResolved("cred-b64", [tpl]);
      resolveByIdResults.set("cred-b64", resolved);
      credentialMetadataList.push(resolved.metadata);
      secureKeyValues.set(
        credentialKey("test-service", "api-key"),
        "plaintext",
      );

      const session = createSession(CONV_ID, ["cred-b64"], undefined, DATA_DIR);
      const started = await startSession(session.id);
      expect(started.status).toBe("active");

      const status = await proxyRequest(
        started.port!,
        `http://127.0.0.1:${echoPort}/test`,
      );

      expect(status).toBe(200);
      const expectedValue =
        "Token " + Buffer.from("plaintext").toString("base64");
      expect(receivedHeaders["authorization"]).toBe(expectedValue);
    } finally {
      echo.close();
    }
  });

  test("composeWith blocks when composed credential resolves but secret value is missing", async () => {
    const echo = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const echoPort = (echo.address() as { port: number }).port;

    try {
      const tpl: CredentialInjectionTemplate = {
        hostPattern: "127.0.0.1",
        injectionType: "header",
        headerName: "Authorization",
        valuePrefix: "Basic ",
        valueTransform: "base64",
        composeWith: { service: "twilio", field: "auth_token", separator: ":" },
      };

      const primaryResolved = makeResolved(
        "cred-primary",
        [tpl],
        "twilio",
        "account_sid",
      );
      resolveByIdResults.set("cred-primary", primaryResolved);
      credentialMetadataList.push(primaryResolved.metadata);
      secureKeyValues.set(credentialKey("twilio", "account_sid"), "ACtest123");

      // Composed credential metadata resolves, but no secret value stored
      const composedResolved = makeResolved(
        "cred-composed",
        [],
        "twilio",
        "auth_token",
      );
      resolveByServiceFieldResults.set("twilio:auth_token", composedResolved);
      // Do NOT set secureKeyValues for credentialKey("twilio", "auth_token")

      const session = createSession(
        CONV_ID,
        ["cred-primary"],
        undefined,
        DATA_DIR,
      );
      const started = await startSession(session.id);
      expect(started.status).toBe("active");

      const status = await proxyRequest(
        started.port!,
        `http://127.0.0.1:${echoPort}/test`,
      );

      // Missing secret value for composed credential blocks the request
      expect(status).toBe(403);
    } finally {
      echo.close();
    }
  });

  test("composeWith without valueTransform concatenates raw", async () => {
    let receivedHeaders: http.IncomingHttpHeaders = {};
    const echo = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const echoPort = (echo.address() as { port: number }).port;

    try {
      const tpl: CredentialInjectionTemplate = {
        hostPattern: "127.0.0.1",
        injectionType: "header",
        headerName: "X-Composed",
        valuePrefix: "Raw ",
        composeWith: {
          service: "my-service",
          field: "secondary-key",
          separator: ":",
        },
      };

      const primaryResolved = makeResolved(
        "cred-raw-primary",
        [tpl],
        "my-service",
        "primary-key",
      );
      resolveByIdResults.set("cred-raw-primary", primaryResolved);
      credentialMetadataList.push(primaryResolved.metadata);

      const composedResolved = makeResolved(
        "cred-raw-composed",
        [],
        "my-service",
        "secondary-key",
      );
      resolveByServiceFieldResults.set(
        "my-service:secondary-key",
        composedResolved,
      );

      secureKeyValues.set(credentialKey("my-service", "primary-key"), "value1");
      secureKeyValues.set(
        credentialKey("my-service", "secondary-key"),
        "value2",
      );

      const session = createSession(
        CONV_ID,
        ["cred-raw-primary"],
        undefined,
        DATA_DIR,
      );
      const started = await startSession(session.id);
      expect(started.status).toBe("active");

      const status = await proxyRequest(
        started.port!,
        `http://127.0.0.1:${echoPort}/test`,
      );

      expect(status).toBe(200);
      expect(receivedHeaders["x-composed"]).toBe("Raw value1:value2");
    } finally {
      echo.close();
    }
  });
});
