/**
 * Bash risk classifier — data-driven command risk classification.
 *
 * Implements RiskClassifier<BashClassifierInput> using the default command
 * registry and user rules. This is the primary classifier for bash/host_bash
 * tools — checker.ts delegates to `bashRiskClassifier.classify()` and maps
 * the result to the permission system's RiskLevel enum.
 *
 * @see /docs/bash-risk-classifier-design.md
 */

import type {
  CommandSegment,
  ParsedCommand,
} from "../tools/terminal/parser.js";
import { getLogger } from "../util/logger.js";
import { DEFAULT_COMMAND_REGISTRY } from "./command-registry.js";
import type {
  ArgRule,
  BashClassifierInput,
  CommandRiskSpec,
  Risk,
  RiskAssessment,
  RiskClassifier,
  ScopeOption,
  UserRule,
} from "./risk-types.js";
import { cachedParse } from "./shell-identity.js";

const log = getLogger("bash-risk-classifier");

// ── Risk ordering helpers ────────────────────────────────────────────────────

const RISK_ORD: Record<Risk, number> = {
  low: 0,
  medium: 1,
  unknown: 2,
  high: 3,
};

/**
 * Numeric ordering for risk comparison.
 *
 * `high` outranks `unknown`: if any segment is definitively high-risk, the
 * overall command is high — the known-dangerous signal dominates. `unknown`
 * sits between medium and high: an unrecognized command is riskier than a
 * known-medium one, but not as definitive as a known-high one.
 */
export function riskOrd(risk: Risk): number {
  return RISK_ORD[risk];
}

/** Return the higher of two risk levels. */
export function maxRisk(a: Risk, b: Risk): Risk {
  return riskOrd(a) >= riskOrd(b) ? a : b;
}

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
// Reuses the same logic as checker.ts for wrapper unwrapping. We inline the
// relevant constants and algorithm here to avoid needing to export from checker.ts.

const WRAPPER_SKIP_FIRST_POSITIONAL = new Set(["timeout", "taskset"]);
const ENV_VALUE_FLAGS = new Set(["-u", "--unset", "-C", "--chdir"]);
const TIMEOUT_VALUE_FLAGS = new Set(["-s", "--signal", "-k", "--kill-after"]);

/**
 * Given a wrapper segment, extract the wrapped program and its args.
 * Returns undefined when no suitable argument is found.
 *
 * Replicates getWrappedProgramWithArgs from checker.ts.
 */
function getWrappedProgramWithArgs(seg: {
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

// ── Git value flags (for subcommand extraction) ──────────────────────────────
const GIT_VALUE_FLAGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
]);

/**
 * Extract the first positional (non-flag) arg, skipping value-consuming flags.
 */
function firstPositionalArg(
  args: string[],
  valueFlags?: Set<string>,
): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      if (valueFlags?.has(arg)) i++;
      continue;
    }
    return arg;
  }
  return undefined;
}

// ── Safe-file downgrade for rm ────────────────────────────────────────────────
// Bare filenames that `rm` is allowed to delete at Medium risk (instead of
// High) in sandboxed bash. Matches checker.ts isRmOfKnownSafeFile behavior.
const RM_SAFE_BARE_FILES = new Set(["BOOTSTRAP.md", "UPDATES.md"]);

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
  program: string,
): { spec: CommandRiskSpec; remainingArgs: string[] } {
  if (!spec.subcommands || args.length === 0) {
    return { spec, remainingArgs: args };
  }

  // For git, skip global flags that consume a value
  const valueFlags = program === "git" ? GIT_VALUE_FLAGS : undefined;
  const subcommandName = firstPositionalArg(args, valueFlags);

  if (!subcommandName || !spec.subcommands[subcommandName]) {
    return { spec, remainingArgs: args };
  }

  const subSpec = spec.subcommands[subcommandName];
  const subIdx = args.indexOf(subcommandName);
  const remainingArgs = args.slice(subIdx + 1);

  // Recurse for nested subcommands (e.g., git stash drop, gh pr view)
  return resolveSubcommand(subSpec, remainingArgs, subcommandName);
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

  // 3. Handle wrappers — unwrap and classify inner command (recursive)
  //    Special case: `command -v` / `command -V` are read-only lookups, not
  //    wrapper invocations. Don't unwrap — instead fall through to arg/base
  //    risk evaluation (the argRule for -v/-V will keep it low).
  if (spec.isWrapper) {
    const isCommandLookup =
      programName === "command" &&
      segment.args.length > 0 &&
      (segment.args[0] === "-v" || segment.args[0] === "-V");

    if (!isCommandLookup) {
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
    // `command -v/-V`: fall through to subcommand/arg rule evaluation
  }

  // 4. Subcommand resolution
  const { spec: resolvedSpec, remainingArgs: _remainingArgs } =
    resolveSubcommand(spec, segment.args, programName);

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
  let risk: Risk = resolvedSpec.baseRisk;
  let reason = resolvedSpec.reason || `${segment.program} (default)`;

  const argRules = resolvedSpec.argRules;
  if (argRules && argRules.length > 0) {
    let anyArgRuleMatched = false;
    let hasUnmatchedNonFlagArg = false;
    let argRuleMaxRisk: Risk = "low";
    let argRuleReason = "";

    const allArgs = segment.args;
    for (let i = 0; i < allArgs.length; i++) {
      const arg = allArgs[i];
      let matched = false;
      for (const rule of argRules) {
        // Standard match: flag or positional against this arg
        if (matchesArgRule(rule, arg)) {
          if (
            !anyArgRuleMatched ||
            riskOrd(rule.risk) > riskOrd(argRuleMaxRisk)
          ) {
            argRuleMaxRisk = rule.risk;
            argRuleReason = rule.reason;
          }
          anyArgRuleMatched = true;
          matched = true;
          break; // first match per arg wins
        }
        // Flag+value lookahead: if this arg is a flag listed in the rule and
        // the rule has a valuePattern, check the NEXT arg against the pattern.
        // This handles `curl -d @file` where `-d` is the flag and `@file` is
        // the value in the next token.
        if (
          rule.flags &&
          rule.valuePattern &&
          rule.flags.includes(arg) &&
          i + 1 < allArgs.length
        ) {
          const nextArg = allArgs[i + 1];
          if (getCompiledPattern(rule.valuePattern).test(nextArg)) {
            if (
              !anyArgRuleMatched ||
              riskOrd(rule.risk) > riskOrd(argRuleMaxRisk)
            ) {
              argRuleMaxRisk = rule.risk;
              argRuleReason = rule.reason;
            }
            anyArgRuleMatched = true;
            matched = true;
            break;
          }
        }
      }
      // Track unmatched non-flag args. Flags (starting with -) are structural
      // and don't need rule coverage for de-escalation safety.
      if (!matched && !arg.startsWith("-")) {
        hasUnmatchedNonFlagArg = true;
      }
    }

    if (anyArgRuleMatched) {
      if (riskOrd(argRuleMaxRisk) >= riskOrd(risk)) {
        // Escalation: always apply (matched rule is >= baseRisk)
        risk = argRuleMaxRisk;
        reason = argRuleReason;
      } else if (!hasUnmatchedNonFlagArg) {
        // De-escalation: only safe when ALL non-flag args matched rules.
        // Every arg is accounted for, so the lower risk is justified.
        risk = argRuleMaxRisk;
        reason = argRuleReason;
      }
      // Otherwise: some args matched low rules but other args went unmatched.
      // Keep baseRisk as the floor — can't safely de-escalate.
    }
  }

  // 6. Check for variable expansion in args (conservative escalation)
  if (segment.args.some((a) => a.includes("$"))) {
    const escalated = escalateOne(resolvedSpec.baseRisk);
    if (riskOrd(escalated) > riskOrd(risk)) {
      risk = escalated;
      reason = `${segment.program} with variable expansion`;
    }
  }

  // 7. rm safe-file downgrade (sandbox only)
  // When rm targets a single known safe bare file (no flags, no path separators),
  // downgrade to medium in sandboxed bash. host_bash keeps high because it has a
  // global ask rule that would prompt medium-risk commands. Matches checker.ts
  // isRmOfKnownSafeFile + toolName guard.
  if (
    programName === "rm" &&
    toolName === "bash" &&
    risk === "high" &&
    segment.args.length === 1
  ) {
    const target = segment.args[0];
    if (
      !target.startsWith("-") &&
      !target.includes("/") &&
      RM_SAFE_BARE_FILES.has(target)
    ) {
      risk = "medium";
      reason = `rm of known safe file: ${target}`;
    }
  }

  return { risk, reason, matchType: "registry" };
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

  // For multi-segment commands (pipelines), use the full command as exact match
  // and individual segment programs for broader options
  if (parsed.segments.length > 1) {
    const fullCommand = parsed.segments.map((s) => s.command).join(" | ");
    addOption(`^${escapeRegex(fullCommand)}$`, fullCommand);
    // Add command-level wildcards for each unique program
    const programs = new Set(parsed.segments.map((s) => s.program));
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

  // Separate args into flags and positionals
  const flags: string[] = [];
  const positionals: string[] = [];
  for (const arg of seg.args) {
    if (arg.startsWith("-")) {
      flags.push(arg);
    } else {
      positionals.push(arg);
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
  if (positionals.length > 1) {
    for (let drop = 1; drop < positionals.length; drop++) {
      const kept = positionals.slice(0, positionals.length - drop);
      const parts = [programName, ...flags, ...kept].filter(Boolean);
      const pattern = `^${parts.map(escapeRegex).join("\\s+")}\\s+.*$`;
      const label = [programName, ...flags, ...kept, "*"].join(" ");
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

// ── Main classifier ──────────────────────────────────────────────────────────

/**
 * Bash risk classifier implementation.
 *
 * Primary classifier for bash/host_bash tools. checker.ts delegates to
 * the singleton `bashRiskClassifier` instance for all bash command
 * risk classification.
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

    // Opaque constructs escalation (matches checker.ts behavior):
    // - With dangerous patterns present → escalate to high
    // - Without dangerous patterns → escalate to medium only
    // checker.ts returns Medium for opaque constructs before the per-segment
    // loop, so opaque-without-danger is medium, not high.
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

    const assessment: RiskAssessment = {
      riskLevel: maxRiskLevel,
      reason: maxReason,
      scopeOptions,
      matchType,
    };

    // Risk assessment analytics
    const primaryProgram = parsed.segments[0]?.program ?? "(none)";
    log.info(
      {
        command,
        program: primaryProgram,
        riskLevel: assessment.riskLevel,
        reason: assessment.reason,
        matchType: assessment.matchType,
      },
      "Risk assessment",
    );

    return assessment;
  }
}

/** Singleton classifier instance with default registry. */
export const bashRiskClassifier = new BashRiskClassifier();
