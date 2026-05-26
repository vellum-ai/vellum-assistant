import { getLogger } from "../util/logger.js";
import {
  type BackgroundWakeIntent,
  computeNextBackgroundWakeIntent,
} from "./next-wake.js";
import {
  clearBackgroundWakeIntent,
  publishBackgroundWakeIntent,
} from "./platform-client.js";

const log = getLogger("background-wake-publisher");
const REFRESH_DEBOUNCE_MS = 250;

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let pendingReason: string | null = null;
let inFlightRefresh: Promise<void> | null = null;
let lastIntentSnapshot: BackgroundWakeIntent | null = null;

export function refreshBackgroundWakeIntent(reason: string): void {
  pendingReason = reason;
  schedulePendingRefresh();
}

function schedulePendingRefresh(): void {
  if (refreshTimer || inFlightRefresh) return;
  refreshTimer = setTimeout(runPendingRefresh, REFRESH_DEBOUNCE_MS);
  refreshTimer.unref?.();
}

function runPendingRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  const reason = pendingReason ?? "unspecified";
  pendingReason = null;
  const refresh = runRefresh(reason).finally(() => {
    if (inFlightRefresh === refresh) {
      inFlightRefresh = null;
    }
    if (pendingReason) {
      schedulePendingRefresh();
    }
  });
  inFlightRefresh = refresh;
}

async function runRefresh(reason: string): Promise<void> {
  try {
    const intent = computeNextBackgroundWakeIntent();
    if (intent) {
      const result = await publishBackgroundWakeIntent(intent);
      lastIntentSnapshot = intent;
      log.debug({ reason, result }, "Background wake intent refreshed");
      return;
    }

    const result = await clearBackgroundWakeIntent(lastIntentSnapshot);
    if (result.status === "cleared") {
      lastIntentSnapshot = null;
    }
    log.debug({ reason, result }, "Background wake intent cleared");
  } catch (err) {
    log.warn({ err, reason }, "Failed to refresh background wake intent");
  }
}

/** @internal Test helper. */
export async function flushBackgroundWakeIntentRefreshForTest(): Promise<void> {
  if (refreshTimer) {
    runPendingRefresh();
  }
  if (inFlightRefresh) {
    await inFlightRefresh;
  }
  if (refreshTimer) {
    await flushBackgroundWakeIntentRefreshForTest();
  }
}

/** @internal Test helper. */
export function resetBackgroundWakeIntentPublisherForTest(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  pendingReason = null;
  inFlightRefresh = null;
  lastIntentSnapshot = null;
}
