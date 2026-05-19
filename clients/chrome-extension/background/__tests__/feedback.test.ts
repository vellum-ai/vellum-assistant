import { describe, test, expect, beforeEach } from "bun:test";

import {
  collectDiagnosticBundle,
  gzipJson,
  submitFeedback,
  type EnvironmentContext,
  type FeedbackFormData,
} from "../feedback.js";
import { appendEvent, clearEventLog, recordRequest } from "../event-log.js";

interface StoredSession {
  email: string;
  environment: string;
  sessionToken?: string;
}

interface MockStores {
  local: Record<string, unknown>;
  session: Record<string, unknown>;
}

function installChromeMock(stores: MockStores): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      getManifest: () => ({ version: "1.2.3" }),
    },
    storage: {
      local: {
        async get(keys?: string | string[] | Record<string, unknown>) {
          if (keys === undefined) return { ...stores.local };
          if (typeof keys === "string") {
            return keys in stores.local ? { [keys]: stores.local[keys] } : {};
          }
          if (Array.isArray(keys)) {
            const out: Record<string, unknown> = {};
            for (const k of keys) {
              if (k in stores.local) out[k] = stores.local[k];
            }
            return out;
          }
          const out: Record<string, unknown> = {};
          for (const k of Object.keys(keys)) {
            out[k] = k in stores.local ? stores.local[k] : keys[k];
          }
          return out;
        },
        async set(items: Record<string, unknown>) {
          Object.assign(stores.local, items);
        },
        async remove(keys: string | string[]) {
          const arr = typeof keys === "string" ? [keys] : keys;
          for (const k of arr) delete stores.local[k];
        },
        async clear() {
          for (const k of Object.keys(stores.local)) delete stores.local[k];
        },
      },
      session: {
        async get(keys?: string | string[] | Record<string, unknown>) {
          if (keys === undefined) return { ...stores.session };
          if (typeof keys === "string") {
            return keys in stores.session
              ? { [keys]: stores.session[keys] }
              : {};
          }
          if (Array.isArray(keys)) {
            const out: Record<string, unknown> = {};
            for (const k of keys) {
              if (k in stores.session) out[k] = stores.session[k];
            }
            return out;
          }
          const out: Record<string, unknown> = {};
          for (const k of Object.keys(keys)) {
            out[k] = k in stores.session ? stores.session[k] : keys[k];
          }
          return out;
        },
        async set(items: Record<string, unknown>) {
          Object.assign(stores.session, items);
        },
        async remove(keys: string | string[]) {
          const arr = typeof keys === "string" ? [keys] : keys;
          for (const k of arr) delete stores.session[k];
        },
        async clear() {
          for (const k of Object.keys(stores.session)) delete stores.session[k];
        },
      },
    },
    debugger: {
      getTargets: (cb: (t: unknown[]) => void) => cb([]),
    },
  };
}

function makeEnv(): EnvironmentContext {
  return { environment: "dev", apiBaseUrl: "https://dev-platform.vellum.ai" };
}

function seedStorage(stores: MockStores, opts: {
  session?: Partial<StoredSession> & { email?: string; sessionToken?: string };
  selectedAssistant?: { id: string; name: string } | null;
  organizationId?: string;
  clientId?: string;
} = {}): void {
  if (opts.session) {
    stores.local["vellum.cloudSession"] = {
      environment: "dev",
      ...opts.session,
    };
  }
  if (opts.selectedAssistant !== undefined && opts.selectedAssistant !== null) {
    stores.local["vellum.selectedAssistant"] = opts.selectedAssistant;
  }
  if (opts.organizationId) {
    stores.local["vellum.connectedOrganizationId"] = opts.organizationId;
  }
  if (opts.clientId) {
    stores.local["vellum.clientId"] = opts.clientId;
  }
}

describe("feedback.gzipJson", () => {
  test("round-trips a JSON value through gzip", async () => {
    installChromeMock({ local: {}, session: {} });
    const payload = { hello: "world", n: 42, nested: { ok: true } };
    const compressed = await gzipJson(payload);
    expect(compressed.size).toBeGreaterThan(0);

    const decompressed = compressed
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    const text = await new Response(decompressed).text();
    expect(JSON.parse(text)).toEqual(payload);
  });
});

describe("feedback.collectDiagnosticBundle", () => {
  let stores: MockStores;

  beforeEach(() => {
    stores = { local: {}, session: {} };
    installChromeMock(stores);
    clearEventLog();
  });

  test("includes extension metadata, mode, and SSE state", async () => {
    seedStorage(stores, {
      session: { email: "vargas@vellum.ai", sessionToken: "tok_should_not_leak" },
      selectedAssistant: { id: "asst_1", name: "Jaxon" },
      organizationId: "org_42",
      clientId: "client-uuid",
    });

    const bundle = await collectDiagnosticBundle({
      env: makeEnv(),
      mode: "cloud",
      sseState: "connected",
      sseDetail: { reason: "ok" },
    });

    expect(bundle.extension.version).toBe("1.2.3");
    expect(bundle.extension.environment).toBe("dev");
    expect(bundle.extension.apiBaseUrl).toBe("https://dev-platform.vellum.ai");
    expect(bundle.mode).toBe("cloud");
    expect(bundle.sse).toEqual({ state: "connected", detail: { reason: "ok" } });
    expect(bundle.assistant).toEqual({ id: "asst_1", name: "Jaxon" });
    expect(bundle.organizationId).toBe("org_42");
    expect(bundle.clientId).toBe("client-uuid");
    expect(bundle.email).toBe("vargas@vellum.ai");
  });

  test("never leaks session tokens or pair JWTs through storage snapshot", async () => {
    seedStorage(stores, {
      session: { sessionToken: "VERY_SECRET_TOKEN", email: "x@y.com" },
      clientId: "abc",
    });
    stores.local["vellum.pairToken"] = "PAIR_SHOULD_NOT_LEAK";
    stores.local["vellum.cloudSession"] = {
      sessionToken: "VERY_SECRET_TOKEN",
      email: "x@y.com",
    };

    const bundle = await collectDiagnosticBundle({
      env: makeEnv(),
      mode: "cloud",
      sseState: "connected",
    });

    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("VERY_SECRET_TOKEN");
    expect(serialized).not.toContain("PAIR_SHOULD_NOT_LEAK");
    // The email lives on the bundle's top-level `email` field, which is OK
    // for support correlation; we just confirm the secret keys aren't here.
    expect(bundle.storage).not.toHaveProperty("vellum.cloudSession");
    expect(bundle.storage).not.toHaveProperty("vellum.pairToken");
  });

  test("includes recent operations and event log entries", async () => {
    seedStorage(stores, { clientId: "abc" });
    recordRequest("req-1", "Page.navigate");
    recordRequest("req-2", "Runtime.evaluate");
    appendEvent("inbound", "test_event", { summary: "first" });
    appendEvent("outbound", "test_event", { summary: "second" });

    const bundle = await collectDiagnosticBundle({
      env: makeEnv(),
      mode: "self-hosted",
      sseState: "paused",
    });

    expect(bundle.operations.length).toBe(2);
    expect(bundle.operations[0]!.operationName).toBe("Page.navigate");
    expect(bundle.eventLog.length).toBe(2);
    expect(bundle.eventLog[0]!.summary).toBe("first");
  });
});

describe("feedback.submitFeedback", () => {
  let stores: MockStores;

  beforeEach(() => {
    stores = { local: {}, session: {} };
    installChromeMock(stores);
    clearEventLog();
  });

  function captureFetch() {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      calls.push({ url, init: init ?? {} });
      return new Response("ok", { status: 200 });
    };
    return { calls, fetchImpl };
  }

  const baseForm: FeedbackFormData = {
    classification: "bug_report",
    message: "Things are broken",
    email: "vargas@vellum.ai",
    includeDiagnostics: false,
  };

  test("posts to {apiBaseUrl}/v1/upload/feedback/ with multipart body", async () => {
    seedStorage(stores, { clientId: "client-uuid" });
    const { calls, fetchImpl } = captureFetch();

    await submitFeedback(baseForm, null, makeEnv(), { fetchImpl });

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(
      "https://dev-platform.vellum.ai/v1/upload/feedback/",
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);

    const formData = calls[0]!.init.body as FormData;
    expect(formData.get("message")).toBe("Things are broken");
    expect(formData.get("classification")).toBe("bug_report");
    expect(formData.get("email")).toBe("vargas@vellum.ai");
    expect(formData.get("device_id")).toBe("client-uuid");
    expect(formData.get("client_version")).toBe("1.2.3");
    expect(formData.get("logs_file")).toBeNull();
  });

  test("attaches gzipped logs_file when a bundle is provided", async () => {
    seedStorage(stores, { clientId: "client-uuid" });
    const { calls, fetchImpl } = captureFetch();

    const bundle = await collectDiagnosticBundle({
      env: makeEnv(),
      mode: "cloud",
      sseState: "connected",
    });

    await submitFeedback(baseForm, bundle, makeEnv(), { fetchImpl });

    const formData = calls[0]!.init.body as FormData;
    const file = formData.get("logs_file") as File | null;
    expect(file).not.toBeNull();
    expect(file!.type).toBe("application/gzip");
    expect(file!.name).toBe("vellum-extension-diagnostics.json.gz");
    expect(file!.size).toBeGreaterThan(0);
  });

  test("attaches X-Session-Token + Vellum-Organization-Id in cloud mode", async () => {
    seedStorage(stores, {
      session: { email: "vargas@vellum.ai", sessionToken: "sess_xyz" },
      organizationId: "org_42",
      selectedAssistant: { id: "asst_1", name: "Jaxon" },
      clientId: "client-uuid",
    });
    const { calls, fetchImpl } = captureFetch();

    await submitFeedback(baseForm, null, makeEnv(), { fetchImpl });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Session-Token"]).toBe("sess_xyz");
    expect(headers["Vellum-Organization-Id"]).toBe("org_42");

    const formData = calls[0]!.init.body as FormData;
    expect(formData.get("assistant_id")).toBe("asst_1");
  });

  test("omits auth headers when self-hosted and no session present", async () => {
    seedStorage(stores, { clientId: "client-uuid" });
    const { calls, fetchImpl } = captureFetch();

    await submitFeedback(baseForm, null, makeEnv(), { fetchImpl });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Session-Token"]).toBeUndefined();
    expect(headers["Vellum-Organization-Id"]).toBeUndefined();
  });

  test("throws when the platform returns a non-2xx", async () => {
    seedStorage(stores, { clientId: "client-uuid" });
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 500 });

    await expect(
      submitFeedback(baseForm, null, makeEnv(), { fetchImpl }),
    ).rejects.toThrow(/Feedback upload failed: HTTP 500/);
  });
});
