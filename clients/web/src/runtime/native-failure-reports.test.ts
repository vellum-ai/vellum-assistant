import { expect, mock, test } from "bun:test";

let isAndroid = false;
let isAvailable = false;
let consent = false;
let reportingResolvedOff = false;
let reports: Array<{
  message: string;
  exceptionType: string;
  stackTrace: string;
  timestamp: number;
}> = [];
let reportAvailable: (() => void) | undefined;

const drainMock = mock(async () => {
  const drained = reports;
  reports = [];
  return { reports: drained };
});
const setEnabledMock = mock(async (_options: { enabled: boolean }) => {});
const addListenerMock = mock(
  async (_eventName: string, listener: () => void) => {
    reportAvailable = listener;
    return { remove: async () => {} };
  },
);
const captureErrorMock = mock((_error: unknown, _options: unknown) => {});

mock.module("@/runtime/platform-detection", () => ({
  isNativeAndroid: () => isAndroid,
}));
mock.module("@capacitor/core", () => ({
  Capacitor: {
    isPluginAvailable: () => isAvailable,
  },
  registerPlugin: () => ({
    drain: drainMock,
    setEnabled: setEnabledMock,
    addListener: addListenerMock,
  }),
}));
mock.module("@/lib/sentry/consent-gate", () => ({
  diagnosticsConsentGranted: () => consent,
  diagnosticsReportingResolvedOff: () => reportingResolvedOff,
}));
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorMock,
}));

const {
  disableNativeFailureReportForwarding,
  flushPendingNativeFailureReports,
  startNativeFailureReportForwarding,
  stopNativeFailureReportForwarding,
} = await import("./native-failure-reports");

test("forwards queued Android failures only while diagnostics reporting is enabled", async () => {
  await startNativeFailureReportForwarding();
  expect(drainMock).not.toHaveBeenCalled();

  isAndroid = true;
  isAvailable = true;
  reports = [
    {
      message: "Unable to prepare the Android voice launch",
      exceptionType: "java.lang.IllegalStateException",
      stackTrace: "java.lang.IllegalStateException\n  at Example.call(Example.java:1)",
      timestamp: 123,
    },
  ];
  await startNativeFailureReportForwarding();
  expect(drainMock).not.toHaveBeenCalled();

  consent = true;
  await startNativeFailureReportForwarding();

  expect(setEnabledMock).toHaveBeenCalledWith({ enabled: true });
  expect(addListenerMock).toHaveBeenCalledWith(
    "reportAvailable",
    expect.any(Function),
  );
  expect(drainMock).toHaveBeenCalledTimes(1);
  const [error, options] = captureErrorMock.mock.calls[0]!;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).toBe("java.lang.IllegalStateException");
  expect(options).toEqual({
    context: "android_native_failure",
    tags: { native_exception_type: "java.lang.IllegalStateException" },
    extra: {
      nativeStackTrace:
        "java.lang.IllegalStateException\n  at Example.call(Example.java:1)",
      occurredAt: "1970-01-01T00:00:00.123Z",
    },
  });

  reports = [
    {
      message: "Unable to receive the Android push token",
      exceptionType: "java.lang.RuntimeException",
      stackTrace: "java.lang.RuntimeException\n  at Example.push(Example.java:2)",
      timestamp: 456,
    },
  ];
  reportAvailable?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(drainMock).toHaveBeenCalledTimes(2);
  expect(captureErrorMock).toHaveBeenCalledTimes(2);

  consent = false;
  reportAvailable?.();
  await flushPendingNativeFailureReports();
  expect(drainMock).toHaveBeenCalledTimes(2);

  await stopNativeFailureReportForwarding();
  expect(setEnabledMock).not.toHaveBeenCalledWith({ enabled: false });

  await disableNativeFailureReportForwarding();
  expect(setEnabledMock).toHaveBeenLastCalledWith({ enabled: false });

  reportingResolvedOff = true;
  await stopNativeFailureReportForwarding();
  expect(setEnabledMock).toHaveBeenLastCalledWith({ enabled: false });
});
