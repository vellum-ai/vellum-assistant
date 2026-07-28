/**
 * Write-time availability guard for inference-profile selections.
 *
 * The profile write routes (create, update, set-active, conversation-scoped
 * pin) refuse to persist a selection that provably cannot dispatch. A profile
 * naming a valid provider id with no connection behind it parses fine and
 * writes fine, but the next chat turn fails with "No provider connection is
 * configured" — a lockout the user has to unwind by hand. Judging the entry
 * the way dispatch will, at write time, turns that into a rejected write with
 * a repair path.
 *
 * This module owns the guard's copy so the four write sites word it
 * identically.
 */

import { ROUTING_IDENTITY_PROVIDERS } from "../../providers/inference/auth.js";
import type { ConnectionAvailability } from "../../providers/inference/connection-availability.js";
import { vellumConnectionAvailability } from "../../providers/inference/connection-availability.js";
import { getManagedUpstream } from "../../providers/vellum-model-routing.js";

/**
 * How the caller should repair the selection. `create`/`update` describe an
 * in-flight write; `repoint` describes an already-persisted profile that some
 * other write (set-active, session pin) is trying to select.
 */
export type ProfileRepairHint =
  | { kind: "create" }
  | { kind: "update" }
  | { kind: "repoint"; profileName: string };

/**
 * Command that proves a profile actually dispatches. Surfaced in write results
 * and in guard errors — `--json` callers (agents) never see the CLI's
 * human-mode hint, so the nudge has to travel in the payload.
 */
export function verifyProfileCommand(name: string): string {
  return `assistant inference send --profile ${name} "Reply with OK"`;
}

function managedAlternative(model: string, repair: ProfileRepairHint): string {
  const served =
    "this model is served by your signed-in Vellum-managed route (no API key needed)";
  switch (repair.kind) {
    case "create":
      return `Recreate with --provider vellum --model ${model} — ${served}.`;
    case "update":
      return `Update it with --provider vellum --model ${model} — ${served}.`;
    case "repoint":
      return `Repoint it first with "assistant inference profiles update ${repair.profileName} --provider vellum --model ${model}" — ${served}.`;
  }
}

function byoSequence(provider: string): string {
  return (
    `To use "${provider}" directly, run ` +
    `"assistant credentials prompt --service ${provider} --field api_key" ` +
    `(secure inline collection — never ask for the key in chat), then ` +
    `"assistant inference providers create ${provider}-personal --provider ${provider} --credential credential/${provider}/api_key", then retry.`
  );
}

/**
 * Build the repair guidance for an unavailable selection: the exact
 * Vellum-managed alternative when the model is managed-routable and the
 * managed route is usable, otherwise the bring-your-own-key sequence.
 */
async function repairGuidance(
  provider: string,
  model: string | undefined,
  repair: ProfileRepairHint,
): Promise<string> {
  if (ROUTING_IDENTITY_PROVIDERS.has(provider)) {
    return `Sign in to the "${provider}" route in Settings → Models & Services, or pick a profile backed by a provider API key, then retry.`;
  }
  if (model && getManagedUpstream(model) !== null) {
    const managed = await vellumConnectionAvailability();
    if (managed.status === "ok") {
      return managedAlternative(model, repair);
    }
  }
  return byoSequence(provider);
}

/**
 * Agent-legible explanation of why a profile cannot serve requests, followed
 * by the repair path and (for in-flight writes) the escape hatch.
 */
export async function describeUnavailableProfile({
  availability,
  provider,
  model,
  repair,
  escapeHatch,
}: {
  availability: ConnectionAvailability;
  provider: string;
  model?: string;
  repair: ProfileRepairHint;
  /** Whether the caller accepts `allowUnavailable` to force the write. */
  escapeHatch: boolean;
}): Promise<string> {
  const parts = [
    availability.message ??
      `Provider "${provider}" cannot serve requests (${availability.status}).`,
    await repairGuidance(provider, model, repair),
  ];
  if (escapeHatch) {
    parts.push(
      "Pass allowUnavailable: true to write it anyway — only do that when intentionally pre-staging config you will finish later.",
    );
  }
  if (repair.kind === "repoint") {
    parts.push(`Then verify with: ${verifyProfileCommand(repair.profileName)}`);
  }
  return parts.join(" ");
}

/**
 * Warning recorded on a forced (`allowUnavailable`) write so the response still
 * names the breakage the guard would have blocked.
 */
export function unavailableProfileWarning(
  name: string,
  availability: ConnectionAvailability,
): string {
  return (
    `Profile "${name}" cannot serve requests yet (${availability.status})` +
    `${availability.message ? `: ${availability.message}` : "."} ` +
    `Written anyway (allowUnavailable). Verify with: ${verifyProfileCommand(name)}`
  );
}
