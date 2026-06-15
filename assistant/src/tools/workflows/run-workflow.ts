/**
 * `run_workflow` core tool — a thin launcher over {@link WorkflowRunManager}.
 *
 * The assistant calls this to kick off an autonomous, multi-agent workflow from
 * either an inline script or a saved workflow name. All orchestration logic
 * lives in the run manager and engine; this tool only validates input, builds
 * the per-run capability manifest, resolves the originating conversation's
 * trust context, and fires `start()` (which returns immediately — the run is
 * asynchronous; its completion is surfaced later as a conversation injection).
 *
 * The tool DESCRIPTION below is the authoring contract the assistant follows
 * when writing workflow scripts. Keep it precise — it is the single source of
 * truth the model reads when generating the `script`.
 */

import { findConversation } from "../../daemon/conversation-registry.js";
import {
  FALLBACK_TURN_TRUST,
  type TrustContext,
} from "../../daemon/trust-context.js";
import {
  CapabilityManifestSchema,
  WORKFLOW_READONLY_BASELINE,
} from "../../workflows/capabilities.js";
import { getWorkflowRunManager } from "../../workflows/run-manager.js";
import {
  RiskLevel,
  type ToolContext,
  type ToolDefinition,
  type ToolExecutionResult,
} from "../types.js";

const RUN_WORKFLOW_DESCRIPTION = `Launch an autonomous, multi-agent WORKFLOW from a script you author (or by saved name). A workflow fans work out across many short-lived leaf agents and orchestrates them deterministically. Returns a runId immediately; the run is asynchronous and you are notified in this conversation when it completes — do NOT poll.

Provide EXACTLY ONE of:
- "script": the workflow source (JavaScript/TypeScript), or
- "name": the name of a previously saved workflow.

=== SCRIPT AUTHORING CONTRACT ===
Scripts run in a SANDBOX with a SYNCHRONOUS host API. You write straight-line code — NEVER use \`await\`. The host functions block and return their results directly. An \`async\` script will NOT work.

The script MUST begin with a pure-literal export (no computed values, no template strings, no concatenation):
  export const meta = { name: "summarize-inbox", description: "Summarize and triage the inbox" };

The script's RESULT is whatever it \`return\`s at the top level: end with \`return <result>;\`. A bare trailing expression (e.g. \`result;\`) is NOT captured — the run would complete with no result. Always \`return\` the value you want surfaced.

DETERMINISM (this is what makes runs resumable): do NOT call \`Date.now()\`, \`Math.random()\`, or \`new Date()\` — they THROW. Pass any timestamps or random seeds in via \`args\`.

HOST API (all synchronous):
- \`agent(prompt, opts?)\` — run ONE leaf agent; returns its result, throws on failure.
- \`leaf(prompt, opts?)\` — return a leaf DESCRIPTOR (does not run yet) for use inside \`parallel\`/\`map\`/\`pipeline\`.
- \`parallel(specs)\` — run an array of \`leaf(...)\` descriptors CONCURRENTLY; returns results in order; a failed leaf becomes \`null\` (does not throw).
- \`map(items, build)\` — \`build(item, i)\` returns a \`leaf(...)\` descriptor per item; runs them like \`parallel\`.
- \`pipeline(items, ...stages)\` — each stage maps over the prior stage's results: return a \`leaf(...)\` descriptor to run an agent on that item, OR any plain value (string/number/object/null) to pass it through UNCHANGED (filter/transform/skip locally — no agent spent). Per-stage barrier (each stage sees the prior stage's results).
- \`phase(title)\` — mark a named phase for progress reporting.
- \`log(msg)\` — emit a progress log line.
- \`usage()\` — returns \`{ agentsSpawned, inputTokens, outputTokens }\` so far.
- \`workflow(name, args)\` — run a SAVED workflow inline (one level deep only).
- \`args\` — the \`args\` object you passed to this tool.

LEAF OPTIONS (\`opts\` for \`agent\`/\`leaf\`):
- \`schema\` — a JSON Schema object LITERAL. Forces structured output via a tool; a leaf WITH a schema runs with NO tools (pure judging/extraction).
- \`label\` — short display label for the leaf.
- \`profile\` — override the model profile (must exist in config).
- \`persona\` — \`true\` makes the leaf speak AS the assistant (identity + memory) — use for output meant to be in her voice; DEFAULT is anonymous (use for impartial judging/extraction of input).

CAPABILITIES (the \`capabilities\` argument — the SINGLE consent point for the whole run):
- Leaves get a curated read-only baseline by default: ${WORKFLOW_READONLY_BASELINE.join(", ")}. NOTE: \`web_fetch\` is NOT in the baseline (an outbound fetch is side-effecting — its URL can exfiltrate data), so if a leaf must fetch a URL, declare \`"web_fetch"\` in \`capabilities.tools\` (which makes the launch prompt for approval once, like any side-effecting tool).
- To let leaves use SIDE-EFFECTING tools (writes, sends, shell, \`web_fetch\`, etc.), list them in \`capabilities.tools\`. Declaring ANY side-effecting tool (or host function) makes the LAUNCH prompt the user for approval ONCE — that single approval covers the whole run; there are no per-call prompts inside it. A read-only run (no declared tools) launches with no prompt. So declare the minimum you need.
- \`capabilities.hostFunctions\` and \`capabilities.persona\` similarly grant host-function and persona access.

Runs are autonomous but BOUNDED by an agent cap; you cannot exceed it. Spend is structurally capped. Side effects are consented to ONCE at launch (via the capability declaration above), not by per-call approval inside the run.

EXAMPLE script:
  export const meta = { name: "rank-options", description: "Rank options and pick the best" };
  phase("score");
  const scores = map(args.options, (opt) => leaf(
    \`Score this option 0-10 for fit: \${opt}\`,
    { schema: { type: "object", properties: { score: { type: "number" } }, required: ["score"] } }
  ));
  const best = agent(\`Given these scored options, write the final recommendation in your own voice: \${JSON.stringify(scores)}\`, { persona: true });
  return best;`;

/**
 * Resolve the {@link TrustContext} to forward to the run's leaves. Prefer the
 * originating conversation's per-turn snapshot (the same context the live turn
 * is running under), then its resolved trust context, and finally a synthetic
 * fallback built from the tool context's `trustClass`. We never elevate beyond
 * the tool context's own trust class.
 */
function resolveTrustContext(context: ToolContext): TrustContext {
  const conversation = findConversation(context.conversationId);
  const fromConversation =
    conversation?.currentTurnTrustContext ?? conversation?.trustContext;
  if (fromConversation) return fromConversation;
  return { ...FALLBACK_TURN_TRUST, trustClass: context.trustClass };
}

async function executeRunWorkflow(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const script = input.script as string | undefined;
  const name = input.name as string | undefined;

  // Exactly one of script/name is required.
  if ((script == null) === (name == null)) {
    return {
      content:
        'Provide exactly one of "script" (inline workflow source) or "name" (saved workflow name).',
      isError: true,
    };
  }

  const args = (input.args as Record<string, unknown> | undefined) ?? {};
  const label = input.label as string | undefined;
  const trustContext = resolveTrustContext(context);

  try {
    // The schema fills defaults (empty arrays, persona:false) for omitted
    // fields and throws (caught below) on a malformed `capabilities` object.
    const manifest = CapabilityManifestSchema.parse(input.capabilities ?? {});
    const { runId } = getWorkflowRunManager().start({
      ...(script != null ? { scriptSource: script } : { name: name as string }),
      args,
      manifest,
      conversationId: context.conversationId,
      ...(label ? { label } : {}),
      trustContext,
    });

    return {
      content: JSON.stringify({
        runId,
        status: "running",
        message:
          "Workflow started. You will be notified in this conversation when it completes — do NOT poll. Use manage_workflows to check status or abort if needed.",
      }),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Failed to start workflow: ${msg}`, isError: true };
  }
}

export const runWorkflowTool = {
  name: "run_workflow",
  description: RUN_WORKFLOW_DESCRIPTION,
  // Default risk is "low": a READ-ONLY run (no side-effecting capabilities)
  // launches silently — spend is structurally capped by the per-run agent cap,
  // and leaves can only read. But when the manifest grants side-effecting tools
  // or host functions, the executor promotes the launch to a fresh interactive
  // approval (`requireFreshApproval`, see executor.ts): the manifest is the
  // single consent point, but it is declared by the model and leaves execute
  // granted tools directly (no per-call prompt), so the launch is where the
  // user consents to the grant. Per-call prompts inside a run are still never
  // used — consent is once, at launch.
  defaultRiskLevel: RiskLevel.Low,
  input_schema: {
    type: "object",
    properties: {
      script: {
        type: "string",
        description:
          "Inline workflow source (JavaScript/TypeScript) following the authoring contract. Provide this OR name, not both.",
      },
      name: {
        type: "string",
        description:
          "Name of a previously saved workflow to run. Provide this OR script, not both.",
      },
      args: {
        type: "object",
        description:
          "Verbatim input object exposed to the script as `args`. Pass timestamps/seeds here (the script may not generate them).",
      },
      capabilities: {
        type: "object",
        description:
          "Per-run capability grant (the single consent point). Leaves get a read-only baseline by default.",
        properties: {
          tools: {
            type: "array",
            items: { type: "string" },
            description:
              "Side-effecting tool names granted to leaves on top of the read-only baseline.",
          },
          hostFunctions: {
            type: "array",
            items: { type: "string" },
            description: "Host-function names the run may invoke.",
          },
          persona: {
            type: "boolean",
            description:
              "Grant leaves access to persona (identity + memory) context.",
          },
        },
      },
      label: {
        type: "string",
        description:
          "Human-readable label for display; defaults to the script's meta.name.",
      },
    },
  },
  execute: executeRunWorkflow,
} satisfies ToolDefinition;
