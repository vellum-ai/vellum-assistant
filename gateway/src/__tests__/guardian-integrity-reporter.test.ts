/**
 * Fail-loud missing-guardian reporter (guardian-integrity-reporter.ts):
 *
 *  - First report emits one error log and one telemetry relay POST with the
 *    `gateway_guardian_missing` check name and the caller's detail.
 *  - Subsequent reports inside the hourly window are dropped (rate limit).
 *  - Relay failures never throw out of the caller.
 */
import { beforeEach, afterEach, describe, expect, mock, test } from "bun:test";

const errorLogs: unknown[] = [];
const warnLogs: unknown[] = [];
mock.module("../logger.js", () => ({
  getLogger: () => ({
    error: (...args: unknown[]) => errorLogs.push(args),
    warn: (...args: unknown[]) => warnLogs.push(args),
    info: () => {},
    debug: () => {},
  }),
}));

await import("./test-preload.js");
const {
  GUARDIAN_MISSING_CHECK_NAME,
  flushGuardianIntegrityReporterForTesting,
  reportMissingGuardian,
  resetGuardianIntegrityReporterForTesting,
  setGuardianIntegrityReporterOverridesForTesting,
} = await import("../guardian-integrity-reporter.js");

type FetchCall = { url: string; init: RequestInit };
let fetchCalls: FetchCall[] = [];
let fetchResult: () => Promise<Response> = async () => new Response("{}");

beforeEach(() => {
  fetchCalls = [];
  fetchResult = async () => new Response("{}");
  errorLogs.length = 0;
  warnLogs.length = 0;
  resetGuardianIntegrityReporterForTesting();
  setGuardianIntegrityReporterOverridesForTesting({
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return fetchResult();
    },
    mintToken: () => "svc-token",
    baseUrl: "http://127.0.0.1:7821",
  });
});

afterEach(() => {
  resetGuardianIntegrityReporterForTesting();
});

describe("reportMissingGuardian", () => {
  test("first report logs an error and relays one watchdog event", async () => {
    reportMissingGuardian({ has_contacts: true, has_actor_tokens: false });
    await flushGuardianIntegrityReporterForTesting();

    expect(errorLogs.length).toBe(1);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe(
      "http://127.0.0.1:7821/v1/internal/telemetry/watchdog",
    );
    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer svc-token");
    expect(JSON.parse(String(fetchCalls[0].init.body))).toEqual({
      check_name: GUARDIAN_MISSING_CHECK_NAME,
      detail: { has_contacts: true, has_actor_tokens: false },
    });
  });

  test("repeat reports inside the hourly window are dropped", async () => {
    reportMissingGuardian({ has_contacts: true, has_actor_tokens: false });
    reportMissingGuardian({ has_contacts: true, has_actor_tokens: false });
    reportMissingGuardian({ has_contacts: true, has_actor_tokens: true });
    await flushGuardianIntegrityReporterForTesting();

    expect(errorLogs.length).toBe(1);
    expect(fetchCalls.length).toBe(1);
  });

  test("a rejected relay never throws out of the caller", async () => {
    fetchResult = async () => {
      throw new Error("daemon unreachable");
    };

    expect(() =>
      reportMissingGuardian({ has_contacts: false, has_actor_tokens: true }),
    ).not.toThrow();
    await flushGuardianIntegrityReporterForTesting();

    expect(errorLogs.length).toBe(1);
    expect(warnLogs.length).toBe(1);
  });

  test("a non-ok relay response is swallowed with a warning", async () => {
    fetchResult = async () => new Response("nope", { status: 500 });

    reportMissingGuardian({ has_contacts: true, has_actor_tokens: true });
    await flushGuardianIntegrityReporterForTesting();

    expect(fetchCalls.length).toBe(1);
    expect(warnLogs.length).toBe(1);
  });
});
