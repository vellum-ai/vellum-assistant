/**
 * `vellum devices [name]` and `vellum devices revoke <hashedDeviceId> [name] [--yes]`
 *
 * Host-side of pairing lifecycle: list and revoke the devices paired to a LOCAL
 * self-hosted assistant. Calls the loopback-only gateway endpoints
 * `GET /v1/devices` and `POST /v1/devices/revoke` (added in the gateway slice),
 * which self-guard loopback + reject any browser/WebView Origin. The gateway
 * only ever stores the HASHED device id, so list returns and revoke accepts the
 * same `hashedDeviceId` (the raw device id is never persisted anywhere).
 *
 * This is the counterpart to `vellum unpair`: `unpair` forgets a connection on
 * the *paired* machine (client side); `devices` revokes a device from the *host*
 * that runs the assistant (server side).
 */

import {
  type AssistantEntry,
  formatAssistantReference,
  getAssistantDisplayName,
  resolveTargetAssistant,
} from "../lib/assistant-config";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import {
  CLI_INTERFACE_ID,
  getClientRegistrationHeaders,
} from "../lib/client-identity.js";
import {
  canPromptForConfirmation,
  confirmAction,
} from "../lib/confirm-action.js";
import { loopbackSafeFetch } from "../lib/loopback-fetch.js";

interface DeviceRecord {
  hashedDeviceId: string;
  platform: string;
  issuedAt: number | null;
  expiresAt: number | null;
  lastUsedAt: number | null;
}

function printUsage(): void {
  console.log(`vellum devices [beta] - List and revoke devices paired to a local assistant

USAGE:
    vellum devices [name]
    vellum devices revoke <hashedDeviceId> [name] [--yes]

ARGUMENTS:
    [name]              Name or id of the local assistant (defaults to the active/sole one)
    <hashedDeviceId>    The device's hashed id (copy it from the list output)

OPTIONS:
    --yes              Skip the interactive confirmation prompt when revoking (for automation)

Lists the devices paired to a local (host-side) assistant, or revokes one by its
hashed id. Runs on the machine that hosts the assistant — paired connections
imported from another machine are managed with 'vellum unpair' instead.

EXAMPLES:
    vellum devices
    vellum devices my-desk
    vellum devices revoke 3f9a1c...
    vellum devices revoke 3f9a1c... my-desk --yes
`);
}

/**
 * Resolve the LOOPBACK gateway base URL for a host-side assistant, or exit with
 * a helpful error. Refuses paired connections (they have no local gateway here)
 * and never falls back to a non-loopback URL.
 */
function resolveLoopbackBase(entry: AssistantEntry): string {
  const displayName = getAssistantDisplayName(entry);

  if (entry.cloud === "paired") {
    console.error(
      `Error: '${displayName}' is a paired connection imported from another machine.`,
    );
    console.error(
      "Run `vellum devices` on the host that runs the assistant to manage its devices.",
    );
    console.error("To forget this connection here, use `vellum unpair`.");
    process.exit(1);
  }

  const base =
    entry.localUrl ||
    (entry.resources?.gatewayPort
      ? `http://127.0.0.1:${entry.resources.gatewayPort}`
      : undefined);
  if (!base) {
    console.error(
      `Error: no local gateway found for '${displayName}'. \`vellum devices\` runs on the machine hosting the assistant.`,
    );
    process.exit(1);
  }

  return base.replace(/\/+$/, "");
}

/** Format an epoch-ms timestamp as ISO, or a placeholder when absent. */
function formatTimestamp(ms: number | null, absent: string): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return absent;
  return new Date(ms).toISOString();
}

async function listDevices(entry: AssistantEntry, base: string): Promise<void> {
  const displayName = getAssistantDisplayName(entry);

  let response: Response;
  try {
    response = await loopbackSafeFetch(`${base}/v1/devices`, {
      method: "GET",
      headers: getClientRegistrationHeaders(CLI_INTERFACE_ID),
    });
  } catch (err) {
    console.error(
      `Error: could not reach the gateway for '${displayName}' at ${base}: ${
        (err as Error).message
      }`,
    );
    process.exit(1);
  }

  if (!response.ok) {
    console.error(
      `Error: gateway returned ${response.status} listing devices for '${displayName}'.`,
    );
    process.exit(1);
  }

  const body = (await response.json()) as { devices?: DeviceRecord[] };
  const devices = body.devices ?? [];

  if (devices.length === 0) {
    console.log(`No devices are paired to ${displayName}.`);
    return;
  }

  console.log(`Devices paired to ${formatAssistantReference(entry)}:`);
  console.log("");
  for (const device of devices) {
    console.log(`  ${device.hashedDeviceId}`);
    console.log(`    platform:   ${device.platform}`);
    console.log(`    issued:     ${formatTimestamp(device.issuedAt, "—")}`);
    console.log(`    expires:    ${formatTimestamp(device.expiresAt, "—")}`);
    console.log(
      `    last used:  ${formatTimestamp(device.lastUsedAt, "never")}`,
    );
    console.log("");
  }
  console.log(
    `${devices.length} device(s). Revoke one with: vellum devices revoke <hashedDeviceId>`,
  );
}

async function revokeDevice(
  entry: AssistantEntry,
  base: string,
  hashedDeviceId: string,
  yes: boolean,
): Promise<void> {
  const displayName = getAssistantDisplayName(entry);

  // Print the resolved identity before acting (cli/AGENTS.md).
  console.log("Device to revoke:");
  console.log(`  Assistant: ${formatAssistantReference(entry)}`);
  console.log(`  Device:    ${hashedDeviceId}`);
  console.log("");

  if (!yes) {
    if (!canPromptForConfirmation()) {
      console.error(
        "Error: Refusing to revoke without confirmation in a non-interactive terminal.",
      );
      console.error("Re-run with --yes to confirm from automation.");
      process.exit(1);
    }
    const confirmed = await confirmAction(
      "Press Enter to revoke, or Esc/q to cancel: ",
    );
    if (!confirmed) {
      console.log("Revoke cancelled.");
      process.exit(1);
    }
  }

  let response: Response;
  try {
    response = await loopbackSafeFetch(`${base}/v1/devices/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getClientRegistrationHeaders(CLI_INTERFACE_ID),
      },
      body: JSON.stringify({ hashedDeviceId }),
    });
  } catch (err) {
    console.error(
      `Error: could not reach the gateway for '${displayName}' at ${base}: ${
        (err as Error).message
      }`,
    );
    process.exit(1);
  }

  if (!response.ok) {
    console.error(
      `Error: gateway returned ${response.status} revoking device for '${displayName}'.`,
    );
    process.exit(1);
  }

  console.log(
    `Revoked device ${hashedDeviceId} from ${displayName}. Its tokens are invalidated; that machine must re-pair to reconnect.`,
  );
}

export async function devices(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  if (args[0] === "revoke") {
    const rest = args.slice(1);
    const yes = rest.includes("--yes");
    const positionals = rest.filter((a) => !a.startsWith("-"));
    const hashedDeviceId = positionals[0];
    if (!hashedDeviceId) {
      console.error("Error: a hashedDeviceId is required to revoke.");
      printUsage();
      process.exit(1);
    }
    const nameArg = positionals.slice(1).join(" ") || undefined;
    const entry = resolveTargetAssistant(nameArg);
    const base = resolveLoopbackBase(entry);
    await revokeDevice(entry, base, hashedDeviceId, yes);
    return;
  }

  const nameArg = parseAssistantTargetArg(args, []);
  const entry = resolveTargetAssistant(nameArg);
  const base = resolveLoopbackBase(entry);
  await listDevices(entry, base);
}
