import {
  getSystemPermissionsState,
  requestSystemPermission,
  type SystemPermissionStatus,
} from "@/runtime/system-permissions";

/**
 * Whether this launch has asked for Input Monitoring on the voice key's
 * behalf. Once per launch: a refusal is the user's answer for the session,
 * and the settings card offers the question again.
 */
let askedThisLaunch = false;

/**
 * Ask macOS for Input Monitoring on the voice key's behalf.
 *
 * The helper cannot see the key without the grant, and the system prompt
 * names the app and nothing else, so the ask belongs where the user is about
 * to try the key and has just read why (`InputMonitoringReason`). Nothing
 * asks on its own: registering the key never prompts, and the settings card
 * carries the question for the user who said no.
 *
 * Resolves to the grant's status once the ask is over: `granted` when it was
 * already given, the answer when it was asked here, the standing status when
 * this launch has asked already, and `null` on a host with no system
 * permissions to ask for.
 */
export async function askForInputMonitoring(): Promise<SystemPermissionStatus | null> {
  const state = await getSystemPermissionsState();
  if (state === null) {
    return null;
  }
  const status = state.inputMonitoring.status;
  if (status === "granted" || askedThisLaunch) {
    return status;
  }
  askedThisLaunch = true;
  const item = await requestSystemPermission("inputMonitoring");
  return item?.status ?? status;
}

export function __resetInputMonitoringAskForTests(): void {
  askedThisLaunch = false;
}
