import { describe, test, expect, beforeEach } from "bun:test";

import {
  buildBundleTarGz,
  BUNDLE_TAR_MEMBER_NAME,
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

async function decompressGzip(blob: Blob): Promise<Uint8Array> {
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function readTrimmedString(bytes: Uint8Array, offset: number, length: number): string {
  const slice = bytes.slice(offset, offset + length);
  let end = slice.length;
  while (end > 0 && slice[end - 1] === 0x00) end -= 1;
  return new TextDecoder().decode(slice.slice(0, end));
}

interface ParsedTarMember {
  name: string;
  typeflag: string;
  magic: string;
  size: number;
  payload: string;
}

function parseFirstTarMember(tarBytes: Uint8Array): ParsedTarMember {
  if (tarBytes.length < 1024) {
    throw new Error(`tar archive is implausibly small: ${tarBytes.length} bytes`);
  }
  const name = readTrimmedString(tarBytes, 0, 100);
  const sizeOctal = readTrimmedString(tarBytes, 124, 12).trim();
  const size = parseInt(sizeOctal, 8);
  const typeflag = String.fromCharCode(tarBytes[156]!);
  const magic = readTrimmedString(tarBytes, 257, 6).trim();
  const payload = new TextDecoder().decode(tarBytes.slice(512, 512 + size));
  return { name, typeflag, magic, size, payload };
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

describe("feedback.buildBundleTarGz", () => {
  test("produces a single-member ustar archive with the JSON payload inside", async () => {
    installChromeMock({ local: {}, session: {} });
    const payload = { hello: "world", n: 42, nested: { ok: true } };
    const archive = await buildBundleTarGz(payload);
    expect(archive.size).toBeGreaterThan(0);

    const tarBytes = await decompressGzip(archive);
    const member = parseFirstTarMember(tarBytes);

    expect(member.name).toBe(BUNDLE_TAR_MEMBER_NAME);
    expect(member.typeflag).toBe("0");
    expect(member.magic).toBe("ustar");
    expect(JSON.parse(member.payload)).toEqual(payload);

    // Archive is laid out as header + padded content + 2 zero trailer blocks.
    // The trailer must be present so the platform's `tarfile.open` stops cleanly.
    const trailerStart = tarBytes.length - 1024;
    for (let i = trailerStart; i < tarBytes.length; i++) {
      expect(tarBytes[i]).toBe(0);
    }
  });

  test("writes an octal-encoded size that round-trips with Python's tarfile semantics", async () => {
    installChromeMock({ local: {}, session: {} });
    // A non-trivially-sized payload so the size field uses multiple digits.
    const payload = { junk: "x".repeat(2048) };
    const archive = await buildBundleTarGz(payload);
    const tarBytes = await decompressGzip(archive);
    const member = parseFirstTarMember(tarBytes);

    const expectedSize = new TextEncoder().encode(JSON.stringify(payload)).length;
    expect(member.size).toBe(expectedSize);
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

  test("attaches a tar.gz logs_file when a bundle is provided", async () => {
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
    expect(file!.name).toBe("vellum-extension-diagnostics.tar.gz");
    expect(file!.size).toBeGreaterThan(0);

    // Gzip magic bytes — sanity check that the file is actually gzipped.
    const head = new Uint8Array(await file!.slice(0, 2).arrayBuffer());
    expect(head[0]).toBe(0x1f);
    expect(head[1]).toBe(0x8b);

    // Decompress and verify the tar header — the platform's
    // `sanitize_tar_gz` validator runs `tarfile.open(..., mode="r|")`, so
    // a plain gzipped JSON blob would be silently dropped on the floor.
    const tarBytes = await decompressGzip(file!);
    const { name, typeflag, magic, size, payload } = parseFirstTarMember(tarBytes);
    expect(name).toBe(BUNDLE_TAR_MEMBER_NAME);
    expect(typeflag).toBe("0"); // regular file
    expect(magic).toBe("ustar");
    expect(size).toBeGreaterThan(0);

    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect((parsed.extension as { version: string }).version).toBe("1.2.3");
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
