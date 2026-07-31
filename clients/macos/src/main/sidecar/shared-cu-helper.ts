/**
 * Lazily-spawned mac-helper instance dedicated to the host-proxy computer-use
 * and app-control executors.
 *
 * This is a separate `MacHelperClient` from the hotkey/dictation client in
 * `hotkey-helper.ts`: the two drive disjoint JSON-RPC surfaces, and keeping
 * them apart means a crash in one supervisor circuit never tears down the
 * other. The underlying process is the same signed binary, so both share the
 * user's Accessibility / Screen Recording TCC grants. The process is not
 * spawned until the first `cu.perform` / `appControl.perform` call, so users
 * who never invoke computer use pay nothing.
 */

import log from "../logger";
import { MacHelperClient } from "./mac-helper";
import { getMacHelperPath } from "./mac-helper-path";

// Computer-use / app-control actions run an accessibility-tree walk, a settle
// delay, and a screen capture before responding — well past the default 2s
// request budget. Some inputs legitimately take longer (computer_use_wait,
// long app_control_sequence, large text typing). Set this just above the
// daemon's 60s host-proxy request timeout so the daemon's timeout stays
// authoritative and the client never reports "did not respond" for an action
// the daemon would still accept; the client timeout only catches a genuinely
// hung helper.
export const CU_HELPER_TIMEOUT_MS = 65_000;

let client: MacHelperClient | null = null;

export function getSharedCuHelper(): MacHelperClient {
  if (!client) {
    client = new MacHelperClient({
      name: "mac helper (computer use)",
      resolveExecutablePath: getMacHelperPath,
      logger: log,
      responseTimeoutMs: CU_HELPER_TIMEOUT_MS,
    });
  }
  return client;
}

export function shutdownSharedCuHelper(): void {
  client?.shutdown();
  client = null;
}
