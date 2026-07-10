/**
 * Per-run capability manifest and scoped tool resolution for the workflow
 * orchestration engine.
 *
 * A workflow script declares — once, at the run level — which tools, host
 * functions, and persona access its leaf agents may use. That declaration is
 * the **single consent point** for the entire run: there are no per-leaf or
 * per-call permission prompts inside a workflow run. The engine/leaf runner
 * calls {@link resolveCapabilities} once and then **hard-denies**
 * any tool invocation that falls outside the resolved set.
 *
 * Resolution policy:
 *
 * - Leaves always get a curated read-only baseline ({@link WORKFLOW_READONLY_BASELINE})
 *   without having to declare it — low-risk file reads, listing, search, and
 *   memory recall.
 * - Side-effecting tools (writes, sends, shell, etc.) are NOT in the baseline;
 *   a run must declare them explicitly in its manifest to grant them.
 * - A small set of tools is {@link WORKFLOW_FORBIDDEN_TOOLS forbidden} and can
 *   never be granted to a leaf regardless of declaration (recursion vectors,
 *   the workflow-management tools themselves, and CES bundle management).
 * - Host-proxy tools (resolved `executionTarget === "host"` — e.g. `host_bash`,
 *   `host_file_*`, computer-use) are rejected too: a leaf builds a synthetic,
 *   anonymous `ToolContext` that carries none of the originating turn's
 *   `transportInterface` / `sourceActorPrincipalId` / proxy-resolver fields, so
 *   a host tool would either fall back to in-container execution or proxy to the
 *   user's machine WITHOUT the authenticated-identity binding those tools rely
 *   on. Unattended, fanned-out leaves must not perform host side effects in v1.
 *   (If host execution is ever wanted, the deliberate path is to thread the
 *   originating tool context through the engine — not to relax this gate.)
 *
 * This module is pure logic: it performs no I/O beyond the synchronous
 * tool-registry lookup.
 */

import { z } from "zod";

import type { TrustClass } from "../runtime/actor-trust-resolver.js";
import { resolveExecutionTarget } from "../tools/execution-target.js";
import {
  getCoreToolOverride,
  getToolOwner,
  peekTool,
} from "../tools/registry.js";
import { isSideEffectTool } from "../tools/side-effects.js";
import type { Tool } from "../tools/types.js";

/**
 * Curated read-only baseline available to every workflow leaf without
 * declaration. Each entry is an existing core tool that only reads, lists, or
 * searches — never writes, sends, executes arbitrary code, or otherwise
 * mutates state. Mutating low-risk tools (e.g. `file_write`, `file_edit`,
 * `remember`) and arbitrary-execution tools (`bash`, `skill_execute`) are
 * deliberately excluded even though some carry a low risk band; the baseline
 * is gated on read-only behavior, not on the risk level alone.
 *
 * `web_fetch` is deliberately NOT here: it is classified as a side-effect tool
 * (an outbound request can trigger external actions or exfiltrate read data via
 * the URL — see {@link isSideEffectTool}). The baseline is auto-granted with NO
 * launch approval, so it must carry no side effects; a run that needs
 * `web_fetch` must DECLARE it in its manifest, which forces the launch approval
 * gate ({@link manifestGrantsSideEffects}). {@link resolveCapabilities} also
 * filters the baseline through `isSideEffectTool` as defense in depth.
 */
export const WORKFLOW_READONLY_BASELINE: readonly string[] = [
  "file_read",
  "file_list",
  "recall",
  "web_search",
];

/**
 * Tools that may never be granted to a workflow leaf, regardless of what a
 * manifest declares. Declaring one is a hard error in
 * {@link resolveCapabilities}.
 *
 * - `subagent_spawn` — leaves must not spawn nested agents; the workflow
 *   engine owns fan-out.
 * - `run_workflow` / `manage_workflows` — the workflow tools themselves;
 *   granting either to a leaf would let it recurse into or reconfigure the
 *   engine.
 */
export const WORKFLOW_FORBIDDEN_TOOLS: readonly string[] = [
  "subagent_spawn",
  "run_workflow",
  "manage_workflows",
];

/**
 * Per-run capability declaration. The single consent surface for a workflow
 * run — `tools` and `hostFunctions` are explicit grants on top of the
 * read-only baseline; `persona` opts the run into persona access.
 */
export const CapabilityManifestSchema = z.object({
  /** Tool names granted to leaves on top of the read-only baseline. */
  tools: z.array(z.string()).default([]),
  /** Host-function names the run is permitted to invoke. */
  hostFunctions: z.array(z.string()).default([]),
  /** Whether leaves may access persona context. */
  persona: z.boolean().default(false),
});

export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

/**
 * Normalize a stored/raw capability blob into a {@link CapabilityManifest},
 * tolerating BOTH shapes a run row can hold:
 *
 * - the canonical declared shape — `tools`/`hostFunctions` as string names; and
 * - the older RESOLVED shape some interrupted runs persisted — `tools` as
 *   resolved Tool objects (`[{ name: "bash" }, …]`).
 *
 * Tool entries are reduced to their string name (string entries kept as-is,
 * object entries via `.name`); non-string host functions are dropped; `persona`
 * is coerced to a boolean. Total and never-throwing: a malformed/absent blob
 * yields empty arrays.
 *
 * This is THE single normalization both the resume path
 * ({@link WorkflowRunManager.resume}, which re-grants the recovered tools) and
 * the consent gate ({@link manifestGrantsSideEffects}) must share, so the gate
 * cannot decide "no side effects" on a blob that `resume()` would in fact grant
 * side-effecting tools from.
 */
export function normalizeCapabilityManifest(
  stored: unknown,
): CapabilityManifest {
  const obj =
    stored && typeof stored === "object"
      ? (stored as Record<string, unknown>)
      : {};
  const tools = Array.isArray(obj.tools)
    ? obj.tools
        .map((t) =>
          typeof t === "string"
            ? t
            : t && typeof t === "object"
              ? ((t as Record<string, unknown>).name as string | undefined)
              : undefined,
        )
        .filter((n): n is string => typeof n === "string")
    : [];
  const hostFunctions = Array.isArray(obj.hostFunctions)
    ? obj.hostFunctions.filter((n): n is string => typeof n === "string")
    : [];
  return { tools, hostFunctions, persona: obj.persona === true };
}

/**
 * True if a capability manifest grants any side-effecting capability beyond the
 * read-only baseline — i.e. it declares one or more `tools` or `hostFunctions`.
 *
 * The tool executor uses this to force an interactive approval at LAUNCH for
 * such runs (and on RESUME of a stored run). The manifest is the single consent
 * point, but it is authored and declared BY THE MODEL, and a workflow's leaves
 * execute granted tools directly (no per-call permission check) — so without a
 * launch/resume-time gate the model could self-grant `bash`/sends/writes and
 * have leaves run them with no user consent, bypassing the gate those tools hit
 * when the main agent calls them. A read-only run (no declared
 * `tools`/`hostFunctions`) needs no prompt.
 *
 * Runs the SAME {@link normalizeCapabilityManifest} the resume path uses, so it
 * detects grants in BOTH the declared (string names) and older resolved
 * (Tool-object) stored shapes — a strict parse would reject the resolved shape
 * and wrongly report "no grant", letting `resume()` restart side-effecting
 * leaves without approval. Total and never-throwing (the risk-gating path must
 * not throw); a malformed/absent manifest yields "no grant" (false). `persona`
 * is deliberately NOT treated as side-effecting: it grants identity/memory
 * context, not world-mutating tools.
 */
export function manifestGrantsSideEffects(rawCapabilities: unknown): boolean {
  const m = normalizeCapabilityManifest(rawCapabilities);
  return m.tools.length > 0 || m.hostFunctions.length > 0;
}

/**
 * Whether `caller` may see and control a workflow run. A guardian (the trusted
 * user) owns every run; any other actor owns only runs ORIGINATED by their own
 * conversation (`run.conversationId` is the launching conversation `run_workflow`
 * records). THE single authorization scope shared by the `manage_workflows` tool
 * and the executor's resume-approval gate, so the gate never prompts for — and
 * thereby leaks the existence of — a run the tool would hide as not-found.
 */
export function callerOwnsWorkflowRun(
  run: { conversationId: string | null },
  caller: { trustClass: TrustClass; conversationId: string },
): boolean {
  return (
    caller.trustClass === "guardian" ||
    run.conversationId === caller.conversationId
  );
}

/**
 * Error thrown when a manifest declares a tool that cannot be resolved — either
 * because it does not exist in the tool registry or because it is forbidden.
 */
export class CapabilityResolutionError extends Error {
  constructor(
    message: string,
    readonly reason: "unknown_tool" | "forbidden_tool" | "host_tool",
    readonly toolName: string,
  ) {
    super(message);
    this.name = "CapabilityResolutionError";
  }
}

/**
 * Result of {@link resolveCapabilities}: the concrete set of tools a leaf may
 * invoke (baseline ∪ declared, minus forbidden), plus the run's host-function
 * and persona grants. The engine/leaf runner hard-denies any invocation whose
 * tool is not in `tools`.
 */
export interface ResolvedCapabilities {
  /**
   * Resolved tool objects from the registry — the exhaustive allow-set for
   * the run. Reuses the registry's {@link Tool} type so the leaf runner can
   * pass these straight through to the agent loop.
   */
  tools: Tool[];
  /** Host functions the run may invoke. */
  hostFunctions: string[];
  /** Whether the run has persona access. */
  persona: boolean;
}

const FORBIDDEN_SET: ReadonlySet<string> = new Set(WORKFLOW_FORBIDDEN_TOOLS);

/**
 * Resolve a read-only baseline name to its TRUSTED CORE implementation — never a
 * workspace (or other non-core) override.
 *
 * The baseline is granted to every workflow leaf WITHOUT a manifest declaration,
 * and {@link manifestGrantsSideEffects} only forces the launch approval for
 * DECLARED tools/host functions. A workspace tool may register under a core name
 * such as `file_read`: the registry stashes the original core tool and installs
 * the workspace replacement under that name. A plain {@link peekTool} lookup would
 * then hand that replacement — with arbitrary side-effecting behavior — to every
 * empty-manifest run, with no consent.
 *
 * Built-in tools carry a `default` owner ({@link getToolOwner}). Any *other*
 * owner holding this name means the live entry is an override, so resolve the
 * stashed original built-in ({@link getCoreToolOverride}) instead — and never
 * the replacement. Returns `undefined` (skipped, not failed) when no trusted
 * built-in entry exists, matching the baseline's convenience-grant semantics.
 */
function resolveBaselineTool(name: string): Tool | undefined {
  const owner = getToolOwner(name);
  if (owner && owner.kind !== "default") {
    return getCoreToolOverride(name);
  }
  return peekTool(name);
}

/**
 * Resolve a {@link CapabilityManifest} into the concrete capability set a
 * workflow run's leaves are allowed to use.
 *
 * The resolved tool set is the read-only baseline unioned with the manifest's
 * declared tools, with forbidden tools rejected (never silently dropped):
 *
 * - Every declared tool name must exist in the tool registry, else a
 *   `CapabilityResolutionError("unknown_tool")` is thrown.
 * - Any declared tool in {@link WORKFLOW_FORBIDDEN_TOOLS} throws a
 *   `CapabilityResolutionError("forbidden_tool")`.
 * - The baseline is intersected against the registry too, so a baseline entry
 *   that is somehow unregistered is skipped rather than dangling.
 *
 * Because the manifest is the single consent point, the returned `tools` array
 * is the exhaustive allow-set: the leaf runner hard-denies anything outside it
 * and performs no per-call permission prompts inside the run.
 */
export function resolveCapabilities(
  manifest: CapabilityManifest,
): ResolvedCapabilities {
  // Reject forbidden declarations up front — even though forbidden tools are
  // stripped from the final union, an explicit declaration is a manifest
  // authoring error and must surface loudly rather than be silently ignored.
  for (const name of manifest.tools) {
    if (FORBIDDEN_SET.has(name)) {
      throw new CapabilityResolutionError(
        `Tool "${name}" is forbidden in workflow runs and cannot be declared.`,
        "forbidden_tool",
        name,
      );
    }
  }

  const resolved = new Map<string, Tool>();

  // Baseline first, resolved from the TRUSTED CORE implementation only (a
  // workspace override of a core name must NOT be auto-granted without consent —
  // see resolveBaselineTool). A baseline name with no trusted core entry
  // (unexpected, but possible if a core tool is renamed or a workspace tool
  // shadows it with no stashed original) is skipped — the baseline is a
  // convenience grant, not a declaration, so a missing entry should not fail
  // the run. Forbidden filtering still applies for defense in depth.
  for (const name of WORKFLOW_READONLY_BASELINE) {
    if (FORBIDDEN_SET.has(name)) {
      continue;
    }
    // Defense in depth: the baseline is auto-granted with NO launch approval, so
    // it must never carry a side-effecting tool (e.g. web_fetch, whose URL can
    // exfiltrate read data or trigger external actions). isSideEffectTool is the
    // single source of truth; skip any baseline entry it flags so the no-consent
    // grant can never include a side effect, even if the list above drifts. A
    // run that needs such a tool must DECLARE it (forcing the launch approval).
    if (isSideEffectTool(name)) {
      continue;
    }
    const tool = resolveBaselineTool(name);
    if (tool) {
      resolved.set(name, tool);
    }
  }

  // Declared tools must exist — a missing one is an authoring error.
  for (const name of manifest.tools) {
    const tool = peekTool(name);
    if (!tool) {
      throw new CapabilityResolutionError(
        `Tool "${name}" declared in the workflow manifest does not exist in the tool registry.`,
        "unknown_tool",
        name,
      );
    }
    // Host-proxy tools run on the user's machine (or fall back to in-container
    // execution) and depend on originating-turn context — `transportInterface`,
    // `sourceActorPrincipalId`, the proxy resolver — that a leaf's synthetic,
    // anonymous ToolContext does not carry. Granting one to an unattended,
    // fanned-out leaf would perform host side effects in the wrong environment
    // or without the authenticated-identity binding the proxy requires. Reject
    // loudly at the consent point rather than silently mis-route at run time.
    if (resolveExecutionTarget(tool) === "host") {
      throw new CapabilityResolutionError(
        `Tool "${name}" runs on the host (executionTarget "host") and cannot ` +
          `be granted to a workflow leaf, which runs unattended without the ` +
          `originating turn's host-routing context.`,
        "host_tool",
        name,
      );
    }
    resolved.set(name, tool);
  }

  return {
    tools: Array.from(resolved.values()),
    hostFunctions: [...manifest.hostFunctions],
    persona: manifest.persona,
  };
}
