/**
 * Pins the ingest sender's failure reporting.
 *
 * The endpoint answers 200 for a batch it accepts and then discards, so a
 * client emitting something the server contract does not permit is
 * indistinguishable from a healthy one unless the drop counts are read. These
 * tests assert that they are read in every build, that a benign drop stays
 * quiet, and that a systemic failure is reported once per condition rather
 * than per flush or per reason combination.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

type IngestResult = {
  data?: {
    accepted: number;
    persisted: number;
    dropped: Record<string, number>;
  };
  response?: { ok: boolean; status: number };
};

let result: IngestResult = {};
let transportError: Error | null = null;

const telemetryIngestCreateMock = mock(async () => {
  if (transportError) {
    throw transportError;
  }
  return result;
});
const captureErrorMock = mock(
  (_error: unknown, _opts: { context: string }) => {},
);

const actualSdk = await import("@/generated/api/sdk.gen");
mock.module("@/generated/api/sdk.gen", () => ({
  ...actualSdk,
  telemetryIngestCreate: telemetryIngestCreateMock,
}));
const actualCapture = await import("@/lib/sentry/capture-error");
mock.module("@/lib/sentry/capture-error", () => ({
  ...actualCapture,
  captureError: captureErrorMock,
}));

const { __resetTelemetryIngestForTests, postTelemetryEvents } =
  await import("./ingest");

function ok(
  accepted: number,
  persisted: number,
  dropped: Record<string, number>,
): IngestResult {
  return {
    data: { accepted, persisted, dropped },
    response: { ok: true, status: 200 },
  };
}

/** Lets the fire-and-forget promise chain settle before assertions. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function reportedMessages(): string[] {
  return captureErrorMock.mock.calls.map((call) => (call[0] as Error).message);
}

beforeEach(() => {
  __resetTelemetryIngestForTests();
  telemetryIngestCreateMock.mockClear();
  captureErrorMock.mockClear();
  transportError = null;
  result = ok(1, 1, {});
});

describe("postTelemetryEvents", () => {
  test("reports nothing when every event persists", async () => {
    postTelemetryEvents([{ type: "watchdog" }]);
    await flush();

    expect(telemetryIngestCreateMock).toHaveBeenCalledTimes(1);
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("reports an accepted-but-dropped batch, naming the server's reason", async () => {
    result = ok(1, 0, { type_not_allowed_for_session: 1 });

    postTelemetryEvents([{ type: "watchdog" }]);
    await flush();

    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(reportedMessages()[0]).toContain("type_not_allowed_for_session");
    const opts = captureErrorMock.mock.calls[0]![1] as {
      context: string;
      level?: string;
    };
    expect(opts.context).toBe("telemetry-ingest");
    expect(opts.level).toBe("warning");
  });

  test("stays quiet when the only drop is the server re-checking consent", async () => {
    result = ok(2, 0, { analytics_opt_out: 2 });

    postTelemetryEvents([{ type: "onboarding" }, { type: "onboarding" }]);
    await flush();

    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  test("still reports a real drop that rides alongside a benign one", async () => {
    result = ok(2, 0, {
      analytics_opt_out: 1,
      type_not_allowed_for_session: 1,
    });

    postTelemetryEvents([{ type: "onboarding" }, { type: "turn" }]);
    await flush();

    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(reportedMessages()[0]).toContain("type_not_allowed_for_session");
    expect(reportedMessages()[0]).not.toContain("analytics_opt_out");
  });

  test("reports one condition once per page load, not once per flush", async () => {
    result = ok(1, 0, { type_not_allowed_for_session: 1 });

    postTelemetryEvents([{ type: "turn" }]);
    await flush();
    postTelemetryEvents([{ type: "turn" }]);
    await flush();

    expect(telemetryIngestCreateMock).toHaveBeenCalledTimes(2);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });

  test("reports a distinct condition separately", async () => {
    result = ok(1, 0, { type_not_allowed_for_session: 1 });
    postTelemetryEvents([{ type: "turn" }]);
    await flush();

    result = ok(1, 0, { unauthenticated: 1 });
    postTelemetryEvents([{ type: "watchdog" }]);
    await flush();

    expect(captureErrorMock).toHaveBeenCalledTimes(2);
  });

  test("dedupes per reason, not per reason combination", async () => {
    result = ok(2, 0, { type_not_allowed_for_session: 1, unauthenticated: 1 });
    postTelemetryEvents([{ type: "turn" }, { type: "watchdog" }]);
    await flush();

    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(reportedMessages()[0]).toContain("type_not_allowed_for_session");
    expect(reportedMessages()[0]).toContain("unauthenticated");

    result = ok(1, 0, { type_not_allowed_for_session: 1 });
    postTelemetryEvents([{ type: "turn" }]);
    await flush();

    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });

  test("a known reason arriving beside a new one reports only the new one", async () => {
    result = ok(1, 0, { type_not_allowed_for_session: 1 });
    postTelemetryEvents([{ type: "turn" }]);
    await flush();

    result = ok(2, 0, { type_not_allowed_for_session: 1, unauthenticated: 1 });
    postTelemetryEvents([{ type: "turn" }, { type: "watchdog" }]);
    await flush();

    expect(captureErrorMock).toHaveBeenCalledTimes(2);
    expect(reportedMessages()[1]).toContain("unauthenticated");
    expect(reportedMessages()[1]).not.toContain("type_not_allowed_for_session");
  });

  test("reports a non-2xx response with its status", async () => {
    result = { response: { ok: false, status: 503 } };

    postTelemetryEvents([{ type: "watchdog" }]);
    await flush();

    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(reportedMessages()[0]).toContain("503");
  });

  test.each([401, 403])(
    "stays quiet on %i: the auth layer refusing the caller is expected",
    async (status) => {
      result = { response: { ok: false, status } };

      postTelemetryEvents([{ type: "watchdog" }]);
      await flush();

      expect(captureErrorMock).not.toHaveBeenCalled();
    },
  );

  test("swallows a transport failure without reporting it", async () => {
    transportError = new Error("network down");

    postTelemetryEvents([{ type: "watchdog" }]);
    await flush();

    expect(captureErrorMock).not.toHaveBeenCalled();
  });
});
