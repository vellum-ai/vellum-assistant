/**
 * Per-run capability manifest and scoped tool resolution for the workflow
 * orchestration engine.
 *
 * A workflow script declares — once, at the run level — which tools, host
 * functions, and persona access its leaf agents may use. That declaration is
 * the **single consent point** for the entire run: there are no per-leaf or
 * per-call permission prompts inside a workflow run. The engine/leaf runner
 * (a later PR) calls {@link resolveCapabilities} once and then **hard-denies**
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
 *
 * This module is pure logic: it performs no feature-flag checks and no I/O
 * beyond the synchronous tool-registry lookup. The `workflows` flag gates the
 * callers, not this code.
 */

import { z } from "zod";

import { getTool } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";

/**
 * Curated read-only baseline available to every workflow leaf without
 * declaration. Each entry is an existing core tool that only reads, lists, or
 * searches — never writes, sends, executes arbitrary code, or otherwise
 * mutates state. Mutating low-risk tools (e.g. `file_write`, `file_edit`,
 * `remember`) and arbitrary-execution tools (`bash`, `skill_execute`) are
 * deliberately excluded even though some carry a low risk band; the baseline
 * is gated on read-only behavior, not on the risk level alone.
 */
export const WORKFLOW_READONLY_BASELINE: readonly string[] = [
  "file_read",
  "file_list",
  "recall",
  "web_search",
  "web_fetch",
];

/**
 * Tools that may never be granted to a workflow leaf, regardless of what a
 * manifest declares. Declaring one is a hard error in
 * {@link resolveCapabilities}.
 *
 * - `subagent_spawn` — leaves must not spawn nested agents; the workflow
 *   engine owns fan-out.
 * - `run_workflow` / `manage_workflows` — the workflow tools themselves
 *   (registered by a later PR; referenced here by name) would let a leaf
 *   recurse into or reconfigure the engine.
 * - `manage_secure_command_tool` — CES secure-bundle management is a
 *   human-in-the-loop install path and is never delegated to an unattended
 *   leaf.
 */
export const WORKFLOW_FORBIDDEN_TOOLS: readonly string[] = [
  "subagent_spawn",
  "run_workflow",
  "manage_workflows",
  "manage_secure_command_tool",
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
 * True if a `run_workflow` capability manifest grants any side-effecting
 * capability beyond the read-only baseline — i.e. it declares one or more
 * `tools` or `hostFunctions`.
 *
 * The tool executor uses this to force an interactive approval at LAUNCH for
 * such runs. The manifest is the single consent point, but it is authored and
 * declared BY THE MODEL, and a workflow's leaves execute granted tools directly
 * (no per-call permission check) — so without a launch-time gate the model
 * could self-grant `bash`/sends/writes and have leaves run them with no user
 * consent, bypassing the gate those tools hit when the main agent calls them.
 * The launch is the one point at which the user can consent to the grant. A
 * read-only run (no declared `tools`/`hostFunctions`) needs no prompt.
 *
 * Total and best-effort: a malformed or absent manifest parses to "no grant"
 * (false). That is safe — `run_workflow` re-parses the manifest at execute time
 * and rejects a malformed one, so the run never starts; and this predicate must
 * never throw from the risk-gating path. `persona` is deliberately NOT treated
 * as side-effecting: it grants identity/memory context, not world-mutating
 * tools.
 */
export function manifestGrantsSideEffects(rawCapabilities: unknown): boolean {
  const parsed = CapabilityManifestSchema.safeParse(rawCapabilities ?? {});
  if (!parsed.success) return false;
  return parsed.data.tools.length > 0 || parsed.data.hostFunctions.length > 0;
}

/**
 * Error thrown when a manifest declares a tool that cannot be resolved — either
 * because it does not exist in the tool registry or because it is forbidden.
 */
export class CapabilityResolutionError extends Error {
  constructor(
    message: string,
    readonly reason: "unknown_tool" | "forbidden_tool",
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

  // Baseline first. A baseline name that is not registered (unexpected, but
  // possible if a core tool is renamed) is skipped — the baseline is a
  // convenience grant, not a declaration, so a missing entry should not fail
  // the run. Forbidden filtering still applies for defense in depth.
  for (const name of WORKFLOW_READONLY_BASELINE) {
    if (FORBIDDEN_SET.has(name)) continue;
    const tool = getTool(name);
    if (tool) resolved.set(name, tool);
  }

  // Declared tools must exist — a missing one is an authoring error.
  for (const name of manifest.tools) {
    const tool = getTool(name);
    if (!tool) {
      throw new CapabilityResolutionError(
        `Tool "${name}" declared in the workflow manifest does not exist in the tool registry.`,
        "unknown_tool",
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
