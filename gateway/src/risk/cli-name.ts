/**
 * Derive the normalized top-level CLI name for a shell command, for telemetry
 * grouping (e.g. `git`, `npm`, `rm`). Reuses the same parsing, wrapper
 * unwrapping, and command-registry lookup the risk classifier uses, so the
 * result is consistent with how commands are otherwise interpreted.
 *
 * Returns the canonical lowercased registry key when the command resolves to a
 * single recognized CLI, or `null` otherwise — unregistered programs,
 * multi-command chains (`;`, `&&`, `||`, `&`), pipelines with no single
 * primary, and opaque/dangerous constructs (eval, heredocs, …). Callers bucket
 * `null` as `"other"`.
 */
import { getWrappedProgramWithArgs } from "./bash-risk-classifier.js";
import { DEFAULT_COMMAND_REGISTRY } from "./command-registry/index.js";
import type { CommandRiskSpec } from "./risk-types.js";
import {
  analyzeShellCommand,
  deriveShellActionKeys,
  type ActionKeyResult,
  type ShellIdentityAnalysis,
} from "./shell-identity.js";

const MAX_WRAPPER_DEPTH = 10;

function lookupSpec(program: string): CommandRiskSpec | undefined {
  const name = program.split("/").pop() ?? program;
  return Object.hasOwn(DEFAULT_COMMAND_REGISTRY, name)
    ? DEFAULT_COMMAND_REGISTRY[name as keyof typeof DEFAULT_COMMAND_REGISTRY]
    : undefined;
}

/**
 * Pure variant for callers (e.g. the risk classifier) that have already run
 * {@link analyzeShellCommand} and {@link deriveShellActionKeys}, so we don't
 * re-parse/re-analyze the command on the permission-check hot path.
 */
export function deriveCliNameFromAnalysis(
  analysis: ShellIdentityAnalysis,
  actionResult: ActionKeyResult,
): string | null {
  // Opaque or dangerous constructs (eval, heredocs, variable-expansion pipes,
  // pipe-to-shell, …) make the primary program unreliable — don't attribute a
  // CLI.
  if (analysis.hasOpaqueConstructs) return null;
  if (analysis.dangerousPatterns.length > 0) return null;

  // Only single-action commands (optionally behind setup prefixes like `cd`)
  // have an unambiguous top-level CLI. Pipelines and multi-command chains do
  // not — `deriveShellActionKeys` reports those as non-simple.
  if (!actionResult.isSimpleAction || !actionResult.primarySegment) {
    return null;
  }

  // Unwrap wrappers (sudo/env/timeout/…) to the program that actually runs,
  // mirroring the unwrapping in the risk classifier. Stop on non-exec modes
  // (e.g. `command -v rm`) so the wrapper itself stays the program.
  let program = actionResult.primarySegment.program;
  let args = actionResult.primarySegment.args;
  let spec = lookupSpec(program);
  let depth = 0;
  while (spec?.isWrapper && depth < MAX_WRAPPER_DEPTH) {
    depth++;
    const isNonExecMode =
      spec.nonExecFlags !== undefined &&
      args.length > 0 &&
      spec.nonExecFlags.includes(args[0]!);
    if (isNonExecMode) break;
    // Pass the path-stripped wrapper name: getWrappedProgramWithArgs matches
    // wrapper names exactly (e.g. skips `FOO=bar` for env, the duration for
    // timeout), so a path-qualified `/usr/bin/env` must be normalized first or
    // its env-assignment args get mistaken for the wrapped program.
    const inner = getWrappedProgramWithArgs({
      program: program.split("/").pop() ?? program,
      args,
    });
    if (!inner) break;
    program = inner.program;
    args = inner.args;
    spec = lookupSpec(program);
  }

  // Normalize to the canonical registry key; unknown programs → null. Matching
  // is case-sensitive (like the rest of the classifier) so case-sensitive keys
  // such as `R` / `Rscript` resolve correctly rather than missing as "other".
  const name = program.split("/").pop() ?? program;
  return Object.hasOwn(DEFAULT_COMMAND_REGISTRY, name) ? name : null;
}

/** Convenience wrapper that parses and analyzes the command from scratch. */
export async function deriveCliName(command: string): Promise<string | null> {
  const analysis = await analyzeShellCommand(command);
  const actionResult = deriveShellActionKeys(analysis);
  return deriveCliNameFromAnalysis(analysis, actionResult);
}
