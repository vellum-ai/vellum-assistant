/**
 * Fail-loud mirror-op-missing reporter (contacts-mirror-op-reporter.ts):
 *
 *  - First report per op emits one error log and one telemetry relay POST with
 *    the `contacts_mirror_op_missing` check name and `{ op, ...detail }`.
 *  - Repeat reports for the same op inside the hourly window are dropped; a
 *    DIFFERENT op still reports (per-op rate limit).
 *  - Relay failures never throw out of the caller.
 *  - `isUnknownIpcMethodError` matches only the IPC server's unknown-method
 *    rejection shape.
 *
 * Logging is observed through the reporter's test-only `log` override —
 * bun's mock.module is process-global and would leak into other test files.
 */
import { beforeEach, afterEach, describe, expect, test } from "bun:test";

const errorLogs: unknown[] = [];
const warnLogs: unknown[] = [];

await import("./test-preload.js");
const {
  MIRROR_OP_MISSING_CHECK_NAME,
  flushMirrorOpReporterForTesting,
  isUnknownIpcMethodError,
  reportMirrorOpMissing,
  resetMirrorOpReporterForTesting,
  setMirrorOpReporterOverridesForTesting,
} = await import("../contacts-mirror-op-reporter.js");

type FetchCall = { url: string; init: RequestInit };
let fetchCalls: FetchCall[] = [];
let fetchResult: () => Promise<Response> = async () => new Response("{}");

beforeEach(() => {
  fetchCalls = [];
  fetchResult = async () => new Response("{}");
  errorLogs.length = 0;
  warnLogs.length = 0;
  resetMirrorOpReporterForTesting();
  setMirrorOpReporterOverridesForTesting({
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return fetchResult();
    },
    mintToken: () => "svc-token",
    baseUrl: "http://127.0.0.1:7821",
    log: {
      error: (detail, msg) => {
        errorLogs.push([detail, msg]);
      },
      warn: (detail, msg) => {
        warnLogs.push([detail, msg]);
      },
    },
  });
});

afterEach(() => {
  resetMirrorOpReporterForTesting();
});

describe("reportMirrorOpMissing", () => {
  test("first report logs an error and relays one watchdog event", async () => {
    reportMirrorOpMissing("contacts_mirror_merge_contact", {
      keepId: "ct_keep",
      mergeId: "ct_merge",
    });
    await flushMirrorOpReporterForTesting();

    expect(errorLogs.length).toBe(1);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe(
      "http://127.0.0.1:7821/v1/internal/telemetry/watchdog",
    );
    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer svc-token");
    expect(JSON.parse(String(fetchCalls[0].init.body))).toEqual({
      check_name: MIRROR_OP_MISSING_CHECK_NAME,
      detail: {
        op: "contacts_mirror_merge_contact",
        keepId: "ct_keep",
        mergeId: "ct_merge",
      },
    });
  });

  test("repeat reports for the same op are dropped; a different op still fires", async () => {
    reportMirrorOpMissing("contacts_mirror_merge_contact", { keepId: "a" });
    reportMirrorOpMissing("contacts_mirror_merge_contact", { keepId: "b" });
    reportMirrorOpMissing("contacts_mirror_upsert_full", { contactId: "c" });
    await flushMirrorOpReporterForTesting();

    expect(errorLogs.length).toBe(2);
    expect(fetchCalls.length).toBe(2);
  });

  test("a rejected relay never throws out of the caller", async () => {
    fetchResult = async () => {
      throw new Error("daemon unreachable");
    };

    expect(() =>
      reportMirrorOpMissing("contacts_mirror_upsert_full", { contactId: "x" }),
    ).not.toThrow();
    await flushMirrorOpReporterForTesting();

    expect(errorLogs.length).toBe(1);
    expect(warnLogs.length).toBe(1);
  });

  test("a non-ok relay response is swallowed with a warning", async () => {
    fetchResult = async () => new Response("nope", { status: 500 });

    reportMirrorOpMissing("contacts_mirror_upsert_full", { contactId: "x" });
    await flushMirrorOpReporterForTesting();

    expect(fetchCalls.length).toBe(1);
    expect(warnLogs.length).toBe(1);
  });
});

describe("isUnknownIpcMethodError", () => {
  test("matches the IPC server's unknown-method rejection", () => {
    expect(
      isUnknownIpcMethodError(
        new Error("Unknown method: contacts_mirror_upsert_full"),
      ),
    ).toBe(true);
  });

  test("does not match other failures", () => {
    expect(isUnknownIpcMethodError(new Error("daemon unavailable"))).toBe(
      false,
    );
    expect(isUnknownIpcMethodError(new Error("Connect timed out"))).toBe(false);
    expect(isUnknownIpcMethodError("Unknown method: x")).toBe(false);
    expect(isUnknownIpcMethodError(undefined)).toBe(false);
  });
});
