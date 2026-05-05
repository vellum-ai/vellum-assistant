/**
 * Bash risk classifier — data-driven command risk classification.
 *
 * Implements RiskClassifier<BashClassifierInput> using the default command
 * registry and user rules. This is the primary classifier for bash/host_bash
 * tools — the permission layer delegates to `bashRiskClassifier.classify()`
 * and maps the result to the permission system's RiskLevel enum.
 *
 * Ported from assistant/src/permissions/bash-risk-classifier.ts with
 * assistant-specific imports replaced for gateway self-containment.
 */

import type { CommandSegment, ParsedCommand } from "./shell-parser.js";
import { parseArgs } from "./arg-parser.js";
import { DEFAULT_COMMAND_REGISTRY } from "./command-registry/index.js";
import {
  maxRisk,
  riskOrd,
  type ArgRule,
  type ArgSchema,
  type AllowlistOption,
  type BashClassifierInput,
  type CommandRiskSpec,
  type Risk,
  type RiskAssessment,
  type RiskClassifier,
  type ScopeOption,
  type UserRule,
} from "./risk-types.js";
import { cachedParse } from "./shell-identity.js";
import { getTrustRuleCache } from "./trust-rule-cache.js";

// ── Risk ordering helpers ────────────────────────────────────────────────────

// riskOrd and maxRisk are imported from risk-types.ts. Only escalateOne is
// defined locally since it is specific to the classifier.

/** Escalate a risk level by one step: low→medium, medium→high, high→high. */
export function escalateOne(risk: Risk): Risk {
  switch (risk) {
    case "low":
      return "medium";
    case "medium":
      return "high";
    case "high":
      return "high";
    case "unknown":
      return "unknown";
  }
}

// Re-export riskOrd and maxRisk for tests and consumers that import from here.
export { riskOrd, maxRisk };

// ── Compiled regex cache ─────────────────────────────────────────────────────
// The registry is static, so we can compile and cache RegExp instances for
// arg rules' valuePatterns. This avoids re-compiling on every classify call.

const compiledPatterns = new Map<string, RegExp>();

function getCompiledPattern(pattern: string): RegExp {
  let re = compiledPatterns.get(pattern);
  if (!re) {
    re = new RegExp(pattern);
    compiledPatterns.set(pattern, re);
  }
  return re;
}

/** Clear the compiled regex cache. Exposed for tests and hot-swap scenarios. */
export function clearCompiledPatterns(): void {
  compiledPatterns.clear();
}

// ── Arg rule matching ────────────────────────────────────────────────────────

/**
 * Check whether an arg matches an ArgRule.
 *
 * - If `flags` is set, the arg must be one of those flags. If `valuePattern`
 *   is also set, the arg must match both the flag list AND the pattern.
 * - If only `valuePattern` is set (no flags), the arg is matched against the
 *   pattern (positional / any-arg matching).
 * - If neither is set, the rule always matches (flag-presence-only rules
 *   should have flags set).
 */
export function matchesArgRule(rule: ArgRule, arg: string): boolean {
  if (rule.flags && rule.flags.length > 0) {
    // Check for inline --flag=value form
    const eqIdx = arg.indexOf("=");
    if (eqIdx > 0) {
      const flagPart = arg.slice(0, eqIdx);
      const valuePart = arg.slice(eqIdx + 1);
      if (rule.flags.includes(flagPart)) {
        // Flag matched via --flag=value. Check valuePattern against the value portion.
        if (rule.valuePattern) {
          return getCompiledPattern(rule.valuePattern).test(valuePart);
        }
        return true;
      }
    }

    // Standard flag match: arg must be one of the listed flags exactly
    if (!rule.flags.includes(arg)) return false;
    // If there's also a valuePattern but no inline value, the next-arg
    // lookahead in classifySegment handles matching. For the flag-only
    // check here, a flag match without inline value and with a valuePattern
    // is a partial match — the caller handles the lookahead.
    if (rule.valuePattern) {
      // Don't match here — let the lookahead in classifySegment handle it.
      // Return false so the caller knows to try next-arg matching.
      return false;
    }
    return true;
  }

  if (rule.valuePattern) {
    return getCompiledPattern(rule.valuePattern).test(arg);
  }

  // No flags and no valuePattern — always matches (unusual but allowed)
  return true;
}

// ── Wrapper unwrapping ───────────────────────────────────────────────────────

const WRAPPER_SKIP_FIRST_POSITIONAL = new Set(["timeout", "taskset"]);
const ENV_VALUE_FLAGS = new Set(["-u", "--unset", "-C", "--chdir"]);
const TIMEOUT_VALUE_FLAGS = new Set(["-s", "--signal", "-k", "--kill-after"]);

/**
 * Given a wrapper segment, extract the wrapped program and its args.
 * Returns undefined when no suitable argument is found.
 */
export function getWrappedProgramWithArgs(seg: {
  program: string;
  args: string[];
}): { program: string; args: string[] } | undefined {
  const isEnv = seg.program === "env";
  const isTimeout = seg.program === "timeout";
  const skipFirst = WRAPPER_SKIP_FIRST_POSITIONAL.has(seg.program);
  let skippedFirstPositional = false;
  for (let i = 0; i < seg.args.length; i++) {
    const arg = seg.args[i];
    if (arg.startsWith("-")) {
      if (isEnv && ENV_VALUE_FLAGS.has(arg)) i++;
      if (isTimeout && TIMEOUT_VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    if (isEnv && arg.includes("=")) continue;
    if (skipFirst && !skippedFirstPositional) {
      skippedFirstPositional = true;
      continue;
    }
    return { program: arg, args: seg.args.slice(i + 1) };
  }
  return undefined;
}

/**
 * Extract the first positional (non-flag) arg, skipping value-consuming flags.
 * Delegates to the shared `parseArgs()` utility for consistent arg parsing.
 */
function firstPositionalArg(
  args: string[],
  valueFlags?: Set<string>,
): string | undefined {
  const schema: ArgSchema = valueFlags
    ? { valueFlags: [...valueFlags], positionals: "none" }
    : { positionals: "none" };
  const parsed = parseArgs(args, schema);
  return parsed.positionals[0];
}

// ── Safe-file downgrade for rm ────────────────────────────────────────────────
// Bare filenames that `rm` is allowed to delete at Medium risk (instead of
// High) in sandboxed bash.
const RM_SAFE_BARE_FILES = new Set(["BOOTSTRAP.md", "UPDATES.md"]);

// Flags that don't affect rm safety — they don't enable recursive deletion or
// change which files are targeted.
const RM_BENIGN_FLAGS = new Set([
  "-f",
  "-i",
  "-v",
  "--force",
  "--interactive",
  "--verbose",
]);

/**
 * Returns true when args contain a top-level help option that is not consumed
 * as a value by another flag.
 *
 * This intentionally ignores:
 * - any `--help` token that appears after `--` (positional mode), and
 * - any `--help` token consumed as the value of a known value-taking flag.
 *
 * Help-mode shortcuts are only enabled for commands with an arg schema.
 */
function hasStandaloneHelpFlag(args: string[], schema?: ArgSchema): boolean {
  if (!schema) return false;

  const valueFlags = new Set(schema.valueFlags ?? []);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return false;

    // Value-taking flags consume the next token (if present), so that token
    // must not be interpreted as a standalone top-level option.
    if (valueFlags.has(arg)) {
      if (i + 1 < args.length) i++;
      continue;
    }

    // Short-flag bundles: -xf where -f is a value flag.  POSIX convention
    // places the value-consuming flag last in a bundle, so check the final
    // character.  If it matches a known short value flag, the next token is
    // its value and must be skipped.
    if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 2) {
      const lastChar = arg[arg.length - 1];
      if (lastChar && valueFlags.has(`-${lastChar}`)) {
        if (i + 1 < args.length) i++;
        continue;
      }
    }

    if (arg.startsWith("-") && arg.includes("=")) {
      const eqIdx = arg.indexOf("=");
      const flagPart = arg.slice(0, eqIdx);
      if (valueFlags.has(flagPart)) continue;
    }

    if (arg === "--help" || arg.startsWith("--help=")) return true;
  }
  return false;
}

// ── Segment classification ───────────────────────────────────────────────────

/**
 * Resolve a CommandRiskSpec through subcommand hierarchy.
 *
 * For commands like `git push --force`, walks the subcommand tree:
 *   git → git.subcommands.push
 *
 * Returns the resolved spec and the remaining args after subcommand resolution.
 */
function resolveSubcommand(
  spec: CommandRiskSpec,
  args: string[],
): { spec: CommandRiskSpec; remainingArgs: string[] } {
  if (!spec.subcommands || args.length === 0) {
    return { spec, remainingArgs: args };
  }

  const valueFlagsList = spec.argSchema?.valueFlags;
  const valueFlags = valueFlagsList ? new Set(valueFlagsList) : undefined;
  const subcommandName = firstPositionalArg(args, valueFlags);

  if (!subcommandName || !spec.subcommands[subcommandName]) {
    return { spec, remainingArgs: args };
  }

  const subSpec = spec.subcommands[subcommandName];
  const subIdx = args.indexOf(subcommandName);
  const remainingArgs = args.slice(subIdx + 1);

  // Recurse for nested subcommands (e.g., git stash drop, gh pr view)
  return resolveSubcommand(subSpec, remainingArgs);
}

/**
 * Classify a single command segment against user rules and the registry.
 *
 * @param toolName - Which tool is being invoked. Used for sandbox-specific
 *   downgrades (e.g. rm safe-file downgrade only applies in sandboxed "bash",
 *   not "host_bash").
 */
export function classifySegment(
  segment: CommandSegment,
  userRules: UserRule[],
  registry: Record<string, CommandRiskSpec>,
  toolName: "bash" | "host_bash" = "bash",
): { risk: Risk; reason: string; matchType: RiskAssessment["matchType"] } {
  // 1. Check user rules first (highest priority)
  // TODO: implement user rule matching with specificity ordering.
  // For now, userRules is always empty so this is a no-op.
  for (const rule of userRules) {
    const re = getCompiledPattern(rule.pattern);
    if (re.test(segment.command)) {
      return { risk: rule.risk, reason: rule.label, matchType: "user_rule" };
    }
  }

  // 2. Look up command in default registry
  //    Use Object.hasOwn to avoid prototype pollution — program names like
  //    "toString" or "hasOwnProperty" exist on Object.prototype and would
  //    return truthy for `registry[name]` even though they're not real entries.
  let programName = segment.program;
  let spec = Object.hasOwn(registry, programName)
    ? registry[programName]
    : undefined;

  if (!spec) {
    // Strip path prefix: /usr/bin/rm → rm
    const bare = programName.split("/").pop();
    if (bare) {
      programName = bare;
      spec = Object.hasOwn(registry, programName)
        ? registry[programName]
        : undefined;
    }
  }

  if (!spec) {
    return {
      risk: "unknown",
      reason: `Unknown command: ${segment.program}`,
      matchType: "unknown",
    };
  }

  // 2b. Help-mode fast path for simple commands (no subcommand tree).
  //     Commands WITH subcommands (e.g. `assistant`) skip this — their
  //     subcommand resolution may assign elevated risk that --help must
  //     not bypass.
  if (
    !spec.subcommands &&
    !spec.isWrapper &&
    hasStandaloneHelpFlag(segment.args, spec.argSchema)
  ) {
    return {
      risk: "low",
      reason: `${segment.program} help output`,
      matchType: "registry",
    };
  }

  // 3. Handle wrappers — unwrap and classify inner command (recursive)
  //    When a wrapper's first arg matches a nonExecFlags entry, the wrapper is
  //    in a non-exec mode (e.g. `command -v`, `env -0`). Skip unwrapping and
  //    fall through to arg/base risk evaluation.
  if (spec.isWrapper) {
    // nonExecFlags only checks args[0] — a flag in a later position won't
    // suppress unwrapping.  This is intentional: wrappers place their mode
    // flag first (e.g. `command -v`, `timeout --help`).
    const isNonExecMode =
      spec.nonExecFlags &&
      segment.args.length > 0 &&
      spec.nonExecFlags.includes(segment.args[0]);

    if (!isNonExecMode) {
      const inner = getWrappedProgramWithArgs(segment);
      if (inner) {
        // Build a synthetic segment for the inner command
        const innerSegment: CommandSegment = {
          command: [inner.program, ...inner.args].join(" "),
          program: inner.program,
          args: inner.args,
          operator: segment.operator,
        };
        const innerResult = classifySegment(
          innerSegment,
          userRules,
          registry,
          toolName,
        );
        return {
          risk: maxRisk(spec.baseRisk as Risk, innerResult.risk),
          reason:
            innerResult.reason || `${programName} wrapping ${inner.program}`,
          matchType: innerResult.matchType,
        };
      }
      // Wrapper with no inner command (bare `sudo`, `env`)
      return {
        risk: spec.baseRisk,
        reason: spec.reason || programName,
        matchType: "registry",
      };
    }
    // Non-exec mode: fall through to subcommand/arg rule evaluation
  }

  // 4. Subcommand resolution
  const { spec: resolvedSpec, remainingArgs: _remainingArgs } =
    resolveSubcommand(spec, segment.args);

  // 4b. Check TrustRuleCache for base risk overrides.
  // The cache overrides ONLY baseRisk — structural data (argRules, subcommands,
  // isWrapper, sandboxAutoApprove, argSchema) still comes from the registry.
  let effectiveBaseRisk: Risk = resolvedSpec.baseRisk;
  let effectiveMatchType: RiskAssessment["matchType"] = "registry";

  try {
    // Build the full subcommand pattern (e.g., "git stash drop") to look up in
    // cache. Walk the subcommand tree the same way resolveSubcommand does,
    // collecting each traversed subcommand name to build the complete chain.
    const subcommandChain: string[] = [];
    {
      let walkSpec: CommandRiskSpec = spec;
      let walkArgs: string[] = segment.args;
      while (walkSpec.subcommands && walkArgs.length > 0) {
        const valueFlagsList = walkSpec.argSchema?.valueFlags;
        const valueFlags = valueFlagsList ? new Set(valueFlagsList) : undefined;
        const subName = firstPositionalArg(walkArgs, valueFlags);
        if (!subName || !walkSpec.subcommands[subName]) break;
        subcommandChain.push(subName);
        const subIdx = walkArgs.indexOf(subName);
        walkArgs = walkArgs.slice(subIdx + 1);
        walkSpec = walkSpec.subcommands[subName];
      }
    }
    const subcommandPattern =
      subcommandChain.length > 0
        ? `${programName} ${subcommandChain.join(" ")}`
        : programName;
    const cachedRule = getTrustRuleCache().findBaseRisk(
      toolName,
      subcommandPattern,
    );
    if (cachedRule) {
      effectiveBaseRisk = cachedRule.risk;
      if (cachedRule.userModified || cachedRule.origin === "user_defined") {
        effectiveMatchType = "user_rule";
      }
    }
  } catch {
    // Cache not initialized (e.g., in tests) — use registry baseRisk
  }

  // 5. Evaluate arg rules
  //
  // Arg rules can both escalate AND de-escalate from baseRisk.
  //
  // De-escalation is only safe when ALL non-flag args are covered by rules.
  // If any arg goes unmatched, baseRisk is the floor — we can't assume an
  // unknown arg is safe. Example: `rm /tmp/foo /etc/passwd` should stay high
  // even though /tmp/foo matches the rm:tmp de-escalation rule, because
  // /etc/passwd is unmatched.
  //
  // Escalation always applies — any matched rule that's higher than baseRisk
  // raises the risk regardless of unmatched args.
  let risk: Risk = effectiveBaseRisk;
  let reason = resolvedSpec.reason || `${segment.program} (default)`;

  const argRules = resolvedSpec.argRules;
  if (argRules && argRules.length > 0) {
    let anyArgRuleMatched = false;
    let hasUnmatchedNonFlagArg = false;
    let argRuleMaxRisk: Risk = "low";
    let argRuleReason = "";

    const allArgs = segment.args;

    // Parse args using the resolved spec's argSchema for structured lookups.
    const schema = resolvedSpec.argSchema ?? {};
    const parsed = parseArgs(allArgs, schema);

    // Track which positionals have been covered by a rule.
    const matchedPositionalIndices = new Set<number>();

    for (const rule of argRules) {
      if (rule.flags && rule.flags.length > 0 && rule.valuePattern) {
        // ── Rules with flags + valuePattern ──────────────────────────────
        // Look up each rule flag in parsed.flags. If the flag has a string
        // value (consumed by parseArgs), test that value against the pattern.
        // This replaces the manual next-token lookahead.
        // Also check for --flag=value forms already handled by parseArgs.
        //
        // Known limitation: parseArgs stores flags in a Map (last value wins),
        // so repeated flags like `curl -d @/etc/shadow -d safe` only check
        // the last value. A future improvement could store flag values as
        // arrays to catch all occurrences.
        let flagValueMatched = false;
        for (const flag of rule.flags) {
          const flagVal = parsed.flags.get(flag);
          if (typeof flagVal === "string") {
            if (getCompiledPattern(rule.valuePattern).test(flagVal)) {
              flagValueMatched = true;
              break;
            }
          }
        }

        // Also check raw args for inline --flag=value forms where the flag
        // name is NOT in the argSchema.valueFlags (parseArgs wouldn't split
        // it). matchesArgRule handles this case.
        if (!flagValueMatched) {
          for (const arg of allArgs) {
            if (matchesArgRule(rule, arg)) {
              flagValueMatched = true;
              break;
            }
          }
        }

        if (flagValueMatched) {
          if (
            !anyArgRuleMatched ||
            riskOrd(rule.risk) > riskOrd(argRuleMaxRisk)
          ) {
            argRuleMaxRisk = rule.risk;
            argRuleReason = rule.reason;
          }
          anyArgRuleMatched = true;
        }
      } else if (rule.flags && rule.flags.length > 0) {
        // ── Rules with flags only (no valuePattern) ──────────────────────
        // Check flag presence in parsed.flags Map.
        // Also scan raw allArgs for combined short flags like `-rf` that
        // parseArgs treats as a single boolean flag token.
        let flagMatched = false;
        for (const flag of rule.flags) {
          if (parsed.flags.has(flag)) {
            flagMatched = true;
            break;
          }
        }

        // Fallback: scan raw args for combined short flags (e.g. `-rf`)
        // and --flag=value forms (e.g. `--set=managed`) that parseArgs
        // doesn't split when the flag isn't in argSchema.valueFlags.
        // matchesArgRule handles both cases via its flag splitting logic.
        if (!flagMatched) {
          for (const arg of allArgs) {
            if (matchesArgRule(rule, arg)) {
              flagMatched = true;
              break;
            }
          }
        }

        if (flagMatched) {
          if (
            !anyArgRuleMatched ||
            riskOrd(rule.risk) > riskOrd(argRuleMaxRisk)
          ) {
            argRuleMaxRisk = rule.risk;
            argRuleReason = rule.reason;
          }
          anyArgRuleMatched = true;
        }
      } else if (rule.valuePattern) {
        // ── Rules with valuePattern only (no flags) ──────────────────────
        // Test each positional against the pattern.
        const re = getCompiledPattern(rule.valuePattern);
        let positionalMatched = false;
        for (let pi = 0; pi < parsed.positionals.length; pi++) {
          if (re.test(parsed.positionals[pi])) {
            positionalMatched = true;
            matchedPositionalIndices.add(pi);
          }
        }

        // Also check raw allArgs for backward compatibility — some patterns
        // may match flag-like tokens or args that parseArgs classified
        // differently.
        if (!positionalMatched) {
          for (const arg of allArgs) {
            if (re.test(arg)) {
              positionalMatched = true;
              break;
            }
          }
        }

        if (positionalMatched) {
          if (
            !anyArgRuleMatched ||
            riskOrd(rule.risk) > riskOrd(argRuleMaxRisk)
          ) {
            argRuleMaxRisk = rule.risk;
            argRuleReason = rule.reason;
          }
          anyArgRuleMatched = true;
        }
      } else {
        // No flags and no valuePattern — always matches (unusual but allowed)
        if (
          !anyArgRuleMatched ||
          riskOrd(rule.risk) > riskOrd(argRuleMaxRisk)
        ) {
          argRuleMaxRisk = rule.risk;
          argRuleReason = rule.reason;
        }
        anyArgRuleMatched = true;
      }
    }

    // Check for unmatched positionals — any positional not covered by a
    // valuePattern-only rule prevents de-escalation.
    for (let pi = 0; pi < parsed.positionals.length; pi++) {
      if (!matchedPositionalIndices.has(pi)) {
        hasUnmatchedNonFlagArg = true;
        break;
      }
    }

    // Also check raw allArgs for non-flag args that parseArgs may have
    // classified as flags (e.g. combined short flags like `-rf` are boolean
    // flags in parseArgs but are non-flag args in the old iteration model).
    // We only need to track unmatched non-flag args from the raw iteration
    // perspective for backward compatibility.
    if (!hasUnmatchedNonFlagArg) {
      for (const arg of allArgs) {
        if (arg.startsWith("-")) continue;
        // Check if this positional was matched by any rule
        let wasMatched = false;
        for (const rule of argRules) {
          if (matchesArgRule(rule, arg)) {
            wasMatched = true;
            break;
          }
          // Check flag+value lookahead match (arg as a flag value)
          if (rule.flags && rule.valuePattern && rule.flags.includes(arg)) {
            // This arg is a flag that matched a rule flag — it's structural
            wasMatched = true;
            break;
          }
        }
        if (!wasMatched) {
          hasUnmatchedNonFlagArg = true;
          break;
        }
      }
    }

    if (anyArgRuleMatched) {
      if (riskOrd(argRuleMaxRisk) >= riskOrd(risk)) {
        // Escalation: always apply (matched rule is >= baseRisk)
        risk = argRuleMaxRisk;
        reason = argRuleReason;
        // The registry's arg rules determined the final risk, not the user's
        // cached base risk override. Reset matchType to "registry".
        effectiveMatchType = "registry";
      } else if (!hasUnmatchedNonFlagArg) {
        // De-escalation: only safe when ALL non-flag args matched rules.
        // Every arg is accounted for, so the lower risk is justified.
        risk = argRuleMaxRisk;
        reason = argRuleReason;
        // Arg rules de-escalated — the registry's arg rules determined the
        // final risk, so matchType should reflect the registry, not the cache.
        effectiveMatchType = "registry";
      }
      // Otherwise: some args matched low rules but other args went unmatched.
      // Keep baseRisk as the floor — can't safely de-escalate.
    }
  }

  // 6. Check for variable expansion in args (conservative escalation)
  // Use max(computedRisk, baseRisk) as the floor for escalation so that
  // de-escalated commands still escalate from at least baseRisk.
  // Example: `curl http://localhost:$PORT` — arg rule de-escalates to low,
  // but baseRisk=medium is the floor, so escalateOne(medium) → high.
  if (segment.args.some((a) => a.includes("$"))) {
    const escalationBase = maxRisk(risk, effectiveBaseRisk);
    const escalated = escalateOne(escalationBase);
    if (riskOrd(escalated) > riskOrd(risk)) {
      risk = escalated;
      reason = `${segment.program} with variable expansion`;
    }
  }

  // 7. rm safe-file downgrade (sandbox only)
  // When rm targets a single known safe bare file (with only benign flags),
  // downgrade to medium in sandboxed bash. host_bash keeps high because it has a
  // global ask rule that would prompt medium-risk commands.
  if (programName === "rm" && toolName === "bash" && risk === "high") {
    // Strip benign flags (-f, -i, -v) and check if exactly one bare filename remains
    const positionalArgs = segment.args.filter((a) => !a.startsWith("-"));
    const flagArgs = segment.args.filter((a) => a.startsWith("-"));
    const allFlagsBenign = flagArgs.every((f) => RM_BENIGN_FLAGS.has(f));

    if (
      positionalArgs.length === 1 &&
      allFlagsBenign &&
      !positionalArgs[0].includes("/") &&
      RM_SAFE_BARE_FILES.has(positionalArgs[0])
    ) {
      risk = "medium";
      effectiveMatchType = "registry";
      reason = `rm of known safe file: ${positionalArgs[0]}`;
    }
  }

  return { risk, reason, matchType: effectiveMatchType };
}

// ── Scope option generation ──────────────────────────────────────────────────

/**
 * Generate scope options (narrowest to broadest) from a parsed command.
 *
 * Algorithm:
 * 1. Exact command (all args literal)
 * 2. Wildcard positionals right-to-left (one at a time)
 * 3. Drop flags (keep command + subcommand)
 * 4. Wildcard at subcommand level
 * 5. Wildcard at command level
 * 6. Deduplicate
 *
 * For commands with complexSyntax, only offer exact and command-level wildcard.
 */
export function generateScopeOptions(
  parsed: ParsedCommand,
  registry: Record<string, CommandRiskSpec> = DEFAULT_COMMAND_REGISTRY,
): ScopeOption[] {
  if (parsed.segments.length === 0) return [];

  const options: ScopeOption[] = [];
  const seen = new Set<string>();

  function addOption(pattern: string, label: string): void {
    if (seen.has(pattern)) return;
    seen.add(pattern);
    options.push({ pattern, label });
  }

  // For multi-segment commands (pipelines, &&, etc.), use the full
  // original command string as exact match (segment reconstruction loses
  // separator characters like `;` and is corrupted for parse-recovery
  // cases where unquoted parens/brackets in path arguments make
  // tree-sitter split a single command into fragments). Per-program
  // wildcards are derived only from non-synthetic segments — synthetic
  // segments come from inside subshells, command substitutions, or
  // parse-recovery, none of which represent commands the user
  // independently typed at the top level.
  if (parsed.segments.length > 1) {
    addOption(
      `^${escapeRegex(parsed.originalCommand)}$`,
      parsed.originalCommand,
    );
    // Add command-level wildcards for each unique non-synthetic program
    const programs = new Set(
      parsed.segments
        .filter((s) => !s.synthetic)
        .map((s) => s.program),
    );
    for (const prog of programs) {
      addOption(`^${escapeRegex(prog)}\\b`, `${prog} *`);
    }
    return options;
  }

  // Single segment
  const seg = parsed.segments[0];
  const programName = seg.program;

  // Check if command has complexSyntax
  const spec = registry[programName];
  const isComplex = spec?.complexSyntax === true;

  // 1. Exact match
  addOption(`^${escapeRegex(seg.command)}$`, seg.command);

  if (isComplex) {
    // For complex syntax, skip intermediate options
    addOption(`^${escapeRegex(programName)}\\b`, `${programName} *`);
    return options;
  }

  // Separate args into flags and positionals.
  // When the command has an argSchema, use parseArgs for accurate flag/positional
  // separation (correctly handles value-consuming flags like `find -name "*.ts"`).
  // Otherwise, fall back to the naive `startsWith("-")` heuristic.
  let flags: string[];
  let positionals: string[];

  if (spec?.argSchema) {
    const parsedArgs = parseArgs(seg.args, spec.argSchema);
    // Convert the flags Map to a flat string array: for value-consuming flags,
    // include both the flag and its value as separate entries; for boolean flags,
    // include just the flag.
    flags = [];
    for (const [flagName, flagValue] of parsedArgs.flags) {
      flags.push(flagName);
      if (typeof flagValue === "string") {
        flags.push(flagValue);
      }
    }
    positionals = parsedArgs.positionals;
  } else {
    flags = [];
    positionals = [];
    for (const arg of seg.args) {
      if (arg.startsWith("-")) {
        flags.push(arg);
      } else {
        positionals.push(arg);
      }
    }
  }

  // Detect subcommand
  let subcommand: string | undefined;
  if (spec?.subcommands && positionals.length > 0) {
    const firstPos = positionals[0];
    if (spec.subcommands[firstPos]) {
      subcommand = firstPos;
    }
  }

  // 2. Wildcard positionals right-to-left
  // When a subcommand is detected, exclude it from the positionals that get
  // wildcarded — it's placed explicitly before flags in the label.
  const wildcardPositionals = subcommand ? positionals.slice(1) : positionals;
  if (wildcardPositionals.length > 1) {
    for (let drop = 1; drop < wildcardPositionals.length; drop++) {
      const kept = wildcardPositionals.slice(
        0,
        wildcardPositionals.length - drop,
      );
      const sub = subcommand ? [subcommand] : [];
      const parts = [programName, ...sub, ...flags, ...kept].filter(Boolean);
      const pattern = `^${parts.map(escapeRegex).join("\\s+")}\\s+.*$`;
      const label = [programName, ...sub, ...flags, ...kept, "*"].join(" ");
      addOption(pattern, label);
    }
  }

  // 3. Drop flags (keep command + subcommand + wildcard)
  if (flags.length > 0) {
    const parts = subcommand ? [programName, subcommand] : [programName];
    addOption(
      `^${parts.map(escapeRegex).join("\\s+")}\\b`,
      [...parts, "*"].join(" "),
    );
  }

  // 4. Subcommand wildcard
  if (subcommand) {
    addOption(
      `^${escapeRegex(programName)}\\s+${escapeRegex(subcommand)}\\b`,
      `${programName} ${subcommand} *`,
    );
  }

  // 5. Command-level wildcard
  addOption(`^${escapeRegex(programName)}\\b`, `${programName} *`);

  return options;
}

/** Escape a string for use in a regex. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Scope → Allowlist conversion ─────────────────────────────────────────────

/**
 * Extract stable tokens from a scope option label: program and subcommand
 * words, skipping flags (starting with `-`) and wildcards (`*`).
 * Returns an `action:` prefixed pattern that matches the action key
 * candidates produced by `buildCommandCandidates()`.
 */
function labelToActionPattern(label: string): string {
  const tokens = label
    .split(/\s+/)
    .filter((t) => !t.startsWith("-") && t !== "*");
  return `action:${tokens.join(" ")}`;
}

/**
 * Convert classifier-produced `ScopeOption[]` to `AllowlistOption[]` format.
 *
 * Patterns must be glob-compatible (not regex) because trust rules use
 * Minimatch for matching against command candidates produced by
 * `buildCommandCandidates()`. The format:
 * - First option (exact match): raw command string
 * - Intermediate options: `action:<program> <subcommand>` patterns that match
 *   action key candidates (labels reorder args so can't be used as globs directly)
 * - Command-level wildcards: `action:<program>` matching the broadest action key
 *
 * Deduplicates by pattern to avoid redundant options when multiple scope levels
 * collapse to the same action key.
 */
export function scopeOptionsToAllowlistOptions(
  scopeOptions: ScopeOption[],
  _parsed: ParsedCommand,
): AllowlistOption[] {
  if (scopeOptions.length === 0) return [];

  const results: AllowlistOption[] = [];
  const seenPatterns = new Set<string>();

  for (let i = 0; i < scopeOptions.length; i++) {
    const opt = scopeOptions[i];
    let description: string;
    let pattern: string;

    if (i === 0) {
      // Exact match: raw command string (matches the raw candidate)
      description = "This exact command";
      pattern = opt.label;
    } else if (
      opt.label.endsWith(" *") &&
      !opt.label.slice(0, -2).includes(" ")
    ) {
      // Command-level wildcard (label is "<program> *"): use action: prefix
      // to match action key candidates from buildCommandCandidates()
      const prog = opt.label.slice(0, -2);
      description = `Any ${prog} command`;
      pattern = `action:${prog}`;
    } else {
      // Intermediate wildcard: use action:<tokens> pattern to match action key
      // candidates. We can't use the label as a glob directly because the scope
      // ladder reorders args (flags before positionals), but command candidates
      // preserve user arg order.
      const actionPattern = labelToActionPattern(opt.label);
      description = "Commands matching this pattern";
      pattern = actionPattern;
    }

    // Deduplicate: skip options that produce the same pattern as a prior one
    if (seenPatterns.has(pattern)) continue;
    seenPatterns.add(pattern);

    results.push({ label: opt.label, description, pattern });
  }

  return results;
}

// ── Main classifier ──────────────────────────────────────────────────────────

/**
 * Bash risk classifier implementation.
 *
 * Primary classifier for bash/host_bash tools. The permission layer
 * delegates to the singleton `bashRiskClassifier` instance for all
 * bash command risk classification.
 */
export class BashRiskClassifier implements RiskClassifier<BashClassifierInput> {
  private readonly registry: Record<string, CommandRiskSpec>;
  private readonly userRules: UserRule[];

  constructor(
    registry: Record<string, CommandRiskSpec> = DEFAULT_COMMAND_REGISTRY,
    userRules: UserRule[] = [],
  ) {
    this.registry = registry;
    this.userRules = userRules;
  }

  async classify(input: BashClassifierInput): Promise<RiskAssessment> {
    const { command, toolName } = input;

    if (!command.trim()) {
      return {
        riskLevel: "low",
        reason: "Empty command",
        scopeOptions: [],
        matchType: "registry",
        allowlistOptions: [],
      };
    }

    const parsed = await cachedParse(command);

    let maxRiskLevel: Risk = "low";
    let maxReason = "";
    let matchType: RiskAssessment["matchType"] = "registry";

    // Classify each segment
    for (const segment of parsed.segments) {
      const result = classifySegment(
        segment,
        this.userRules,
        this.registry,
        toolName,
      );
      if (riskOrd(result.risk) > riskOrd(maxRiskLevel)) {
        maxRiskLevel = result.risk;
        maxReason = result.reason;
        matchType = result.matchType;
      } else if (!maxReason && result.reason) {
        // Capture reason from first segment even if it doesn't escalate
        // (avoids empty reason for all-low commands like `ls`)
        maxReason = result.reason;
        matchType = result.matchType;
      }
    }

    // No segments → opaque
    if (parsed.segments.length === 0) {
      maxRiskLevel = "high";
      maxReason = "No parseable command segments";
      matchType = "unknown";
    }

    // Dangerous patterns escalate to at least high
    if (parsed.dangerousPatterns.length > 0) {
      if (riskOrd("high") > riskOrd(maxRiskLevel)) {
        maxRiskLevel = "high";
      }
      maxReason = parsed.dangerousPatterns[0].description;
    }

    // Opaque constructs escalation:
    // - With dangerous patterns present → escalate to high
    // - Without dangerous patterns → escalate to medium only
    if (parsed.hasOpaqueConstructs) {
      const opaqueTarget: Risk =
        parsed.dangerousPatterns.length > 0 ? "high" : "medium";
      if (riskOrd(opaqueTarget) > riskOrd(maxRiskLevel)) {
        maxRiskLevel = opaqueTarget;
      }
      if (!maxReason) {
        maxReason = "Command contains opaque constructs";
      }
    }

    const scopeOptions = generateScopeOptions(parsed, this.registry);
    const allowlistOptions = scopeOptionsToAllowlistOptions(
      scopeOptions,
      parsed,
    );

    const assessment: RiskAssessment = {
      riskLevel: maxRiskLevel,
      reason: maxReason,
      scopeOptions,
      matchType,
      allowlistOptions,
    };

    return assessment;
  }
}

/** Singleton classifier instance with default registry. */
export const bashRiskClassifier = new BashRiskClassifier();
