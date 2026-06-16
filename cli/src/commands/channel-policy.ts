/**
 * `vellum channel-policy` — read/write the per-channel inbound admission floor
 * and per-conversation overrides. Talks to the gateway's
 * `/v1/channel-admission-policy` endpoints (P2) and the conversation-scoped
 * override endpoints consumed by P3.
 *
 * §8.1: internal channels (`vellum`/`platform`/`a2a`) are filtered out of the
 * `list` output. The gateway is the source of truth for which channels are
 * client-controllable; this client double-checks against a local denylist so
 * we never display them even if a future gateway accidentally surfaces them.
 *
 * §8.3: `conversation-set` warns when the chosen override is less restrictive
 * than the channel-type floor (i.e. admits more senders) so guardians don't
 * silently widen an inbound surface without realising it.
 */

import { extractAssistantFlag } from "../lib/arg-utils.js";
import { AssistantClient } from "../lib/assistant-client.js";
import {
  formatAssistantLookupError,
  lookupAssistantByIdentifier,
} from "../lib/assistant-config.js";

// ---------------------------------------------------------------------------
// Types — mirror gateway/src/db/admission-policy-store.ts
// ---------------------------------------------------------------------------

export const ADMISSION_POLICY_VALUES = [
  "no_one",
  "guardian_only",
  "trusted_contacts",
  "any_contact",
  "strangers",
] as const;

export type AdmissionPolicy = (typeof ADMISSION_POLICY_VALUES)[number];

/**
 * Numeric floor for each policy. Higher = more restrictive. Matches
 * `ADMISSION_FLOOR` in the gateway store. We use this client-side only for
 * the divergence warning in `conversation-set` — the gateway is still the
 * authority for actual admission decisions.
 */
const ADMISSION_FLOOR: Record<AdmissionPolicy, number> = {
  no_one: 5,
  guardian_only: 4,
  trusted_contacts: 3,
  any_contact: 2,
  strangers: 1,
};

/**
 * Channels the gateway is internal-only — `vellum` is the local desktop/web
 * client surface, `a2a` is peer-to-peer assistant traffic, `platform` is the
 * vembda-managed control plane. Locking any of these would brick the user's
 * own desktop app or platform connection. Source: §8.1 of the rollout plan.
 */
const INTERNAL_CHANNELS = new Set<string>(["vellum", "platform", "a2a"]);

interface PolicyView {
  channelType: string;
  policy: AdmissionPolicy;
  note: string | null;
  updatedAt: number | null;
}

interface ListResponse {
  policies: PolicyView[];
}

interface SingleResponse {
  policy: PolicyView;
}

interface ConversationOverrideView {
  conversationId: string;
  channelType: string | null;
  override: AdmissionPolicy | null;
  typeFloor: AdmissionPolicy;
  updatedAt: number | null;
}

interface ConversationOverrideResponse {
  override: ConversationOverrideView;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log("Usage: vellum channel-policy <subcommand> [options]");
  console.log("");
  console.log(
    "Read and write the per-channel inbound admission floor and per-conversation overrides.",
  );
  console.log("");
  console.log("Subcommands:");
  console.log(
    "  list                                       List policies for every client-controllable channel",
  );
  console.log(
    "  set <channel-type> <floor>                 Set the floor for one channel",
  );
  console.log(
    "  conversation-list <conversation-id>        Show override + type-floor for one conversation",
  );
  console.log(
    "  conversation-set <conversation-id> <floor> Set the per-conversation override",
  );
  console.log("");
  console.log("Floors (least to most restrictive):");
  console.log(
    "  strangers, any_contact, trusted_contacts, guardian_only, no_one",
  );
  console.log("");
  console.log("Options:");
  console.log(
    "  --assistant <name>  Target a specific assistant instead of the active one",
  );
  console.log("  --help, -h          Show this help");
  console.log("");
  console.log("Examples:");
  console.log("  $ vellum channel-policy list");
  console.log("  $ vellum channel-policy set slack guardian_only");
  console.log(
    "  $ vellum channel-policy conversation-list slack:C0123",
  );
  console.log(
    "  $ vellum channel-policy conversation-set slack:C0123 trusted_contacts",
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createClient(assistantName?: string): AssistantClient {
  let assistantId: string | undefined;
  if (assistantName) {
    const result = lookupAssistantByIdentifier(assistantName);
    if (result.status !== "found") {
      throw new Error(formatAssistantLookupError(assistantName, result));
    }
    assistantId = result.entry.assistantId;
  }
  try {
    return new AssistantClient(assistantId ? { assistantId } : undefined);
  } catch {
    throw new Error(
      assistantName
        ? `No assistant found matching '${assistantName}'.`
        : "No assistant found. Hatch one with 'vellum hatch' first.",
    );
  }
}

function isAdmissionPolicy(value: string): value is AdmissionPolicy {
  return (ADMISSION_POLICY_VALUES as readonly string[]).includes(value);
}

function parseFloor(raw: string | undefined, ctx: string): AdmissionPolicy {
  if (!raw || !isAdmissionPolicy(raw)) {
    console.error(
      `Invalid floor for ${ctx}: "${raw ?? ""}". Must be one of: ${ADMISSION_POLICY_VALUES.join(", ")}`,
    );
    process.exit(1);
  }
  return raw;
}

function isInternalChannel(channelType: string): boolean {
  return INTERNAL_CHANNELS.has(channelType);
}

function rethrowFetchError(err: unknown): never {
  if (
    err instanceof TypeError &&
    (err.message.includes("fetch") || err.message.includes("connect"))
  ) {
    throw new Error(
      "Could not reach the assistant gateway. Is it running? Try 'vellum wake'.",
    );
  }
  throw err;
}

async function readJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `${ctx} failed: HTTP ${res.status}${body ? ` ${body}` : ""}`,
    );
  }
  return (await res.json()) as T;
}

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - s.length));
}

function printPolicyTable(policies: PolicyView[]): void {
  if (policies.length === 0) {
    console.log("No client-controllable channels.");
    return;
  }
  const headers = { channel: "CHANNEL", floor: "FLOOR", note: "NOTE" };
  const rows = policies
    .slice()
    .sort((a, b) => a.channelType.localeCompare(b.channelType))
    .map((p) => ({
      channel: p.channelType,
      floor: p.policy,
      note: p.note ?? "",
    }));
  const all = [headers, ...rows];
  const w = {
    channel: Math.max(...all.map((r) => r.channel.length)),
    floor: Math.max(...all.map((r) => r.floor.length)),
    note: Math.max(...all.map((r) => r.note.length)),
  };
  const fmt = (r: typeof headers) =>
    `${pad(r.channel, w.channel)}  ${pad(r.floor, w.floor)}  ${r.note}`;
  console.log(fmt(headers));
  console.log(
    `${"-".repeat(w.channel)}  ${"-".repeat(w.floor)}  ${"-".repeat(w.note)}`,
  );
  for (const r of rows) console.log(fmt(r));
}

function warnIfDivergent(
  override: AdmissionPolicy,
  typeFloor: AdmissionPolicy,
  channelType: string | null,
): void {
  if (ADMISSION_FLOOR[override] >= ADMISSION_FLOOR[typeFloor]) return;
  const channelLabel = channelType ?? "channel";
  // Hint mirrors the macOS/web inline-warning copy so cross-surface
  // messaging stays consistent.
  console.warn(
    `warning: ${channelLabel} default is ${typeFloor}; choosing ${override} for this conversation will admit more senders.`,
  );
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

async function listPolicies(assistantName?: string): Promise<void> {
  const client = createClient(assistantName);
  let res: Response;
  try {
    res = await client.get("/channel-admission-policy");
  } catch (err) {
    rethrowFetchError(err);
  }
  const data = await readJson<ListResponse>(res, "list channel policies");
  // Belt-and-suspenders filter against §8.1 even if the gateway forgets.
  const visible = data.policies.filter(
    (p) => !isInternalChannel(p.channelType),
  );
  printPolicyTable(visible);
}

async function setPolicy(
  channelType: string,
  floor: AdmissionPolicy,
  assistantName?: string,
): Promise<void> {
  if (isInternalChannel(channelType)) {
    console.error(
      `Channel "${channelType}" is internal (vellum/platform/a2a) and is not user-configurable.`,
    );
    process.exit(1);
  }
  const client = createClient(assistantName);
  let res: Response;
  try {
    // The gateway accepts both POST and PUT for the upsert; we use POST so
    // CLI/AssistantClient need no new verb. See `gateway/src/index.ts:1499`.
    res = await client.post(
      `/channel-admission-policy/${encodeURIComponent(channelType)}`,
      { policy: floor },
    );
  } catch (err) {
    rethrowFetchError(err);
  }
  if (res.status === 403) {
    console.error(
      `Channel "${channelType}" is not user-configurable (gateway returned 403).`,
    );
    process.exit(1);
  }
  const data = await readJson<SingleResponse>(res, "set channel policy");
  console.log(
    `Set ${data.policy.channelType} floor to ${data.policy.policy}.`,
  );
}

async function conversationList(
  conversationId: string,
  assistantName?: string,
): Promise<void> {
  const client = createClient(assistantName);
  let res: Response;
  try {
    res = await client.get(
      `/channel-admission-policy/conversations/${encodeURIComponent(conversationId)}`,
    );
  } catch (err) {
    rethrowFetchError(err);
  }
  const data = await readJson<ConversationOverrideResponse>(
    res,
    "fetch conversation override",
  );
  const o = data.override;
  console.log(`Conversation:  ${o.conversationId}`);
  console.log(`Channel type:  ${o.channelType ?? "(unknown)"}`);
  console.log(`Type floor:    ${o.typeFloor}`);
  console.log(`Override:      ${o.override ?? "(none — inherits type floor)"}`);
  if (o.override) warnIfDivergent(o.override, o.typeFloor, o.channelType);
}

async function conversationSet(
  conversationId: string,
  floor: AdmissionPolicy,
  assistantName?: string,
): Promise<void> {
  const client = createClient(assistantName);
  let res: Response;
  try {
    res = await client.post(
      `/channel-admission-policy/conversations/${encodeURIComponent(conversationId)}`,
      { floor },
    );
  } catch (err) {
    rethrowFetchError(err);
  }
  const data = await readJson<ConversationOverrideResponse>(
    res,
    "set conversation override",
  );
  const o = data.override;
  console.log(
    `Set override on ${o.conversationId} to ${o.override ?? "(inherits type floor)"}.`,
  );
  if (o.override) warnIfDivergent(o.override, o.typeFloor, o.channelType);
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function channelPolicy(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const assistantName = extractAssistantFlag(args);
  const subcommand = args[0];

  if (!subcommand) {
    printUsage();
    process.exit(1);
  }

  switch (subcommand) {
    case "list":
      await listPolicies(assistantName);
      return;

    case "set": {
      const channelType = args[1];
      const rawFloor = args[2];
      if (!channelType || !rawFloor) {
        console.error("Usage: vellum channel-policy set <channel-type> <floor>");
        process.exit(1);
      }
      const floor = parseFloor(rawFloor, channelType);
      await setPolicy(channelType, floor, assistantName);
      return;
    }

    case "conversation-list": {
      const conversationId = args[1];
      if (!conversationId) {
        console.error(
          "Usage: vellum channel-policy conversation-list <conversation-id>",
        );
        process.exit(1);
      }
      await conversationList(conversationId, assistantName);
      return;
    }

    case "conversation-set": {
      const conversationId = args[1];
      const rawFloor = args[2];
      if (!conversationId || !rawFloor) {
        console.error(
          "Usage: vellum channel-policy conversation-set <conversation-id> <floor>",
        );
        process.exit(1);
      }
      const floor = parseFloor(rawFloor, conversationId);
      await conversationSet(conversationId, floor, assistantName);
      return;
    }

    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      printUsage();
      process.exit(1);
  }
}
