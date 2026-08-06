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
 * Shell-quote a value interpolated into a generated command. Profile names
 * (and custom-endpoint model ids) are arbitrary strings, and the generated
 * commands are explicitly meant to be run — an unquoted name with whitespace
 * or metacharacters would break, or worse, execute as extra shell words.
 * Values made only of conventional id characters pass through unquoted so the
 * common case stays readable.
 */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9./:_-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Command that proves a profile actually dispatches. Surfaced in write results
 * and in guard errors — `--json` callers (agents) never see the CLI's
 * human-mode hint, so the nudge has to travel in the payload.
 */
export function verifyProfileCommand(name: string): string {
  return `assistant inference send --profile ${shellQuote(name)} "Reply with OK"`;
}

function managedAlternative(model: string, repair: ProfileRepairHint): string {
  const served =
    "this model is served by your signed-in Vellum-managed route (no API key needed)";
  const quotedModel = shellQuote(model);
  switch (repair.kind) {
    case "create":
      return `Recreate with --provider vellum --model ${quotedModel} — ${served}.`;
    case "update":
      return `Update it with --provider vellum --model ${quotedModel} — ${served}.`;
    case "repoint":
      return `Repoint it first with "assistant inference profiles update ${shellQuote(repair.profileName)} --provider vellum --model ${quotedModel}" — ${served}.`;
  }
}

const PROMPT_FOR_KEY = (provider: string): string =>
  `"assistant credentials prompt --service ${provider} --field api_key" ` +
  `(secure inline collection — never ask for the key in chat)`;

/**
 * Repair for a connection that exists but has no stored key: collecting the
 * key is the whole fix — suggesting a `providers create` here would collide
 * with the existing row.
 */
function storeMissingKey(provider: string): string {
  return `To store the missing key, run ${PROMPT_FOR_KEY(provider)}, then retry.`;
}

function byoSequence(provider: string): string {
  return (
    `To use "${provider}" directly, run ` +
    `${PROMPT_FOR_KEY(provider)}, then ` +
    `"assistant inference providers create ${provider}-personal --provider ${provider} --credential credential/${provider}/api_key", then retry.`
  );
}

/**
 * Build the repair guidance for an unavailable selection: the exact
 * Vellum-managed alternative when the model is managed-routable and the
 * managed route is usable; otherwise key collection alone when a connection
 * already exists and only its credential is missing, or the full
 * bring-your-own-key sequence when there is no connection at all.
 */
async function repairGuidance(
  provider: string,
  model: string | undefined,
  repair: ProfileRepairHint,
  status: ConnectionAvailability["status"],
): Promise<string> {
  // An incomplete profile has no connection to diagnose: the repair is
  // finishing the profile itself. Its `provider` may also be absent, which
  // the branches below would interpolate as the string "undefined".
  if (status === "incomplete") {
    return "Set both a provider and a model on the profile in Settings → Models & Services, then retry.";
  }
  if (ROUTING_IDENTITY_PROVIDERS.has(provider)) {
    return `Sign in to the "${provider}" route in Settings → Models & Services, or pick a profile backed by a provider API key, then retry.`;
  }
  if (model && getManagedUpstream(model) !== null) {
    const managed = await vellumConnectionAvailability();
    if (managed.status === "ok") {
      return managedAlternative(model, repair);
    }
  }
  if (status === "missing_credential") {
    return storeMissingKey(provider);
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
    await repairGuidance(provider, model, repair, availability.status),
  ];
  if (escapeHatch) {
    parts.push(
      "Pass --allow-unavailable (allowUnavailable over HTTP) to write it anyway — only do that when intentionally pre-staging config you will finish later.",
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
