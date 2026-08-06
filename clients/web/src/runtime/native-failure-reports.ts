import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";

import {
  diagnosticsConsentGranted,
  diagnosticsReportingResolvedOff,
} from "@/lib/sentry/consent-gate";
import { captureError } from "@/lib/sentry/capture-error";
import { isNativeAndroid } from "@/runtime/platform-detection";

interface NativeFailureReport {
  message: string;
  exceptionType: string;
  stackTrace: string;
  timestamp: number;
}

interface NativeFailureReportsPlugin {
  drain(): Promise<{ reports: NativeFailureReport[] }>;
  setEnabled(options: { enabled: boolean }): Promise<void>;
  addListener(
    eventName: "reportAvailable",
    listener: () => void,
  ): Promise<PluginListenerHandle>;
}

const PLUGIN_NAME = "NativeFailureReports";
const NativeFailureReports =
  registerPlugin<NativeFailureReportsPlugin>(PLUGIN_NAME);

let listenerPromise: Promise<void> | null = null;

function isAvailable(): boolean {
  return isNativeAndroid() && Capacitor.isPluginAvailable(PLUGIN_NAME);
}

function reportNativeFailure(report: NativeFailureReport): void {
  const error = new Error(report.message);
  error.name = report.exceptionType;
  captureError(error, {
    context: "android_native_failure",
    tags: { native_exception_type: report.exceptionType },
    extra: {
      nativeStackTrace: report.stackTrace,
      occurredAt: new Date(report.timestamp).toISOString(),
    },
  });
}

export async function flushPendingNativeFailureReports(): Promise<void> {
  if (!isAvailable() || !diagnosticsConsentGranted()) {
    return;
  }
  try {
    const { reports } = await NativeFailureReports.drain();
    for (const report of reports) {
      reportNativeFailure(report);
    }
  } catch (error) {
    captureError(error, {
      context: "android_native_failure_drain",
      bestEffort: true,
    });
  }
}

function ensureListener(): Promise<void> {
  if (listenerPromise === null) {
    listenerPromise = NativeFailureReports.addListener(
      "reportAvailable",
      () => {
        void flushPendingNativeFailureReports();
      },
    )
      .then(() => {
        return undefined;
      })
      .catch((error) => {
        listenerPromise = null;
        throw error;
      });
  }
  return listenerPromise;
}

export async function startNativeFailureReportForwarding(): Promise<void> {
  if (!isAvailable() || !diagnosticsConsentGranted()) {
    return;
  }
  try {
    await ensureListener();
    if (!diagnosticsConsentGranted()) {
      return;
    }
    await NativeFailureReports.setEnabled({ enabled: true });
    if (!diagnosticsConsentGranted()) {
      await NativeFailureReports.setEnabled({ enabled: false });
      return;
    }
    await flushPendingNativeFailureReports();
  } catch (error) {
    captureError(error, {
      context: "android_native_failure_listener",
      bestEffort: true,
    });
  }
}

export async function stopNativeFailureReportForwarding(): Promise<void> {
  if (!isAvailable() || !diagnosticsReportingResolvedOff()) {
    return;
  }
  await disableNativeFailureReportForwarding();
}

export async function disableNativeFailureReportForwarding(): Promise<void> {
  if (!isAvailable()) {
    return;
  }
  try {
    await NativeFailureReports.setEnabled({ enabled: false });
  } catch (error) {
    console.error("Unable to disable Android failure reporting", error);
  }
}
