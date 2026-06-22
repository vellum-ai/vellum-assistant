/**
 * `vellum confirm <assistant> --request-id <id> --decision allow|deny`
 *
 * Resolve a pending tool confirmation on a running assistant via its
 * runtime HTTP API. The assistant raises a `confirmation_request` event
 * (with a `requestId`) when a tool exceeds the auto-approve risk
 * threshold; this command answers it so the turn can proceed. Headless
 * automation (e.g. the evals harness) uses it to approve requests that
 * would otherwise hang waiting for an interactive user.
 */

import { extractFlag } from "../lib/arg-utils.js";
import { AssistantClient } from "../lib/assistant-client.js";

function printUsage(): void {
  console.log(`vellum confirm - Resolve a pending tool confirmation

USAGE:
    vellum confirm [assistant] --request-id <id> [--decision allow|deny]

ARGUMENTS:
    [assistant]    Instance name (default: active assistant)

OPTIONS:
    --request-id <id>     The requestId from the confirmation_request event (required)
    --decision <value>    allow or deny (default: allow)
    --json                Output raw JSON response

EXAMPLES:
    vellum confirm --request-id ede263d9-cc45-4d63-86f8-a656d17b3a3a
    vellum confirm my-assistant --request-id req-1 --decision deny
    vellum confirm --json --request-id req-1
`);
}

interface ParsedConfirmArgs {
  assistantId?: string;
  requestId: string;
  decision: "allow" | "deny";
  jsonOutput: boolean;
}

type ParseResult =
  | { ok: true; value: ParsedConfirmArgs }
  | { ok: false; error: string };

/**
 * Parse `vellum confirm` arguments. Pure: does no I/O and never exits, so the
 * positional/flag rules can be unit-tested. Defaults the decision to `allow`,
 * which is the common automation case (approve and continue).
 */
export function parseConfirmArgs(rawArgs: string[]): ParseResult {
  const jsonOutput = rawArgs.includes("--json");
  let args = rawArgs.filter((a) => a !== "--json");

  const requestIdFlagPresent = args.includes("--request-id");
  const [requestId, afterRequestId] = extractFlag(args, "--request-id");
  args = afterRequestId;

  const decisionFlagPresent = args.includes("--decision");
  const [decisionRaw, afterDecision] = extractFlag(args, "--decision");
  args = afterDecision;

  // `extractFlag` strips a trailing value-less flag, which would otherwise let
  // the next positional masquerade as the flag's value (or, for --decision,
  // silently fall back to "allow" and approve a tool call the caller never
  // meant to approve). Treat a flag supplied without a value as an error.
  if (requestIdFlagPresent && requestId === undefined) {
    return { ok: false, error: "--request-id requires a value." };
  }
  if (!requestId) {
    return { ok: false, error: "--request-id is required." };
  }

  if (decisionFlagPresent && decisionRaw === undefined) {
    return {
      ok: false,
      error: '--decision requires a value ("allow" or "deny").',
    };
  }
  const decision = decisionRaw ?? "allow";
  if (decision !== "allow" && decision !== "deny") {
    return {
      ok: false,
      error: `--decision must be "allow" or "deny" (got "${decision}").`,
    };
  }

  if (args.length >= 2) {
    return { ok: false, error: "unexpected extra arguments." };
  }

  return {
    ok: true,
    value: { assistantId: args[0], requestId, decision, jsonOutput },
  };
}

function exitWithUsage(error: string): never {
  console.error(`Error: ${error}`);
  console.error("");
  printUsage();
  process.exit(1);
}

export async function confirm(): Promise<void> {
  const rawArgs = process.argv.slice(3);

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }

  const parsed = parseConfirmArgs(rawArgs);
  if (!parsed.ok) {
    exitWithUsage(parsed.error);
  }

  const { assistantId, requestId, decision, jsonOutput } = parsed.value;

  const client = new AssistantClient({ assistantId });

  const response = await client.post("/confirm", { requestId, decision });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error(
      `Error: HTTP ${response.status}: ${body || response.statusText}`,
    );
    process.exit(1);
  }

  const result = (await response.json()) as { accepted: boolean };

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      result.accepted
        ? `Confirmation resolved (${decision})`
        : `Confirmation not accepted`,
    );
  }
}
