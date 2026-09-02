import { win32 } from "node:path";

import { classifySegment } from "./bash-risk-classifier.js";
import { DEFAULT_COMMAND_REGISTRY } from "./command-registry/index.js";
import {
  maxRisk,
  riskOrd,
  type AllowlistOption,
  type DangerousPattern,
  type DirectoryScopeOption,
  type Risk,
  type RiskAssessment,
  type ScopeOption,
} from "./risk-types.js";
import { getTrustRuleCache } from "./trust-rule-cache.js";

interface PowerShellSegment {
  raw: string;
  program: string;
  args: string[];
}

export interface PowerShellRiskAssessment extends RiskAssessment {
  actionKeys: string[];
  commandCandidates: string[];
  dangerousPatterns: DangerousPattern[];
  opaqueConstructs: boolean;
  isComplexSyntax: boolean;
  resolvedPaths?: string[];
}

const ALIASES = new Map<string, string>([
  ["cat", "get-content"],
  ["gc", "get-content"],
  ["type", "get-content"],
  ["ls", "get-childitem"],
  ["dir", "get-childitem"],
  ["gci", "get-childitem"],
  ["pwd", "get-location"],
  ["cd", "set-location"],
  ["sl", "set-location"],
  ["cp", "copy-item"],
  ["copy", "copy-item"],
  ["cpi", "copy-item"],
  ["mv", "move-item"],
  ["move", "move-item"],
  ["mi", "move-item"],
  ["ren", "rename-item"],
  ["rni", "rename-item"],
  ["rm", "remove-item"],
  ["del", "remove-item"],
  ["erase", "remove-item"],
  ["rd", "remove-item"],
  ["rmdir", "remove-item"],
  ["ri", "remove-item"],
  ["sc", "set-content"],
  ["ac", "add-content"],
  ["clc", "clear-content"],
  ["iwr", "invoke-webrequest"],
  ["curl", "invoke-webrequest"],
  ["wget", "invoke-webrequest"],
  ["irm", "invoke-restmethod"],
  ["iex", "invoke-expression"],
]);

const LOW_RISK_COMMANDS = new Set([
  "get-alias",
  "get-childitem",
  "get-command",
  "get-content",
  "get-date",
  "get-help",
  "get-item",
  "get-itemproperty",
  "get-location",
  "get-member",
  "get-process",
  "get-service",
  "measure-object",
  "out-string",
  "select-object",
  "sort-object",
  "test-connection",
  "test-path",
  "where-object",
]);

const MEDIUM_RISK_COMMANDS = new Set([
  "add-content",
  "copy-item",
  "export-csv",
  "import-csv",
  "invoke-restmethod",
  "invoke-webrequest",
  "move-item",
  "new-item",
  "rename-item",
  "set-content",
  "set-item",
  "set-itemproperty",
  "set-location",
  "start-service",
  "stop-process",
  "stop-service",
]);

const HIGH_RISK_COMMANDS = new Set([
  "add-type",
  "clear-content",
  "clear-disk",
  "disable-computerrestore",
  "diskpart",
  "format",
  "format.com",
  "format-volume",
  "initialize-disk",
  "invoke-command",
  "invoke-expression",
  "new-object",
  "powershell-script",
  "remove-item",
  "remove-itemproperty",
  "restart-computer",
  "set-executionpolicy",
  "start-process",
  "stop-computer",
  "uninstall-package",
]);

const FILESYSTEM_COMMANDS = new Set([
  "add-content",
  "clear-content",
  "copy-item",
  "get-childitem",
  "get-content",
  "get-item",
  "get-itemproperty",
  "move-item",
  "new-item",
  "remove-item",
  "remove-itemproperty",
  "rename-item",
  "set-content",
  "set-item",
  "set-itemproperty",
  "test-path",
]);

const PATH_PARAMETERS = new Set([
  "-destination",
  "-filepath",
  "-literalpath",
  "-path",
  "-targetpath",
]);

const LOW_RISK_VERBS = new Set([
  "compare",
  "convertfrom",
  "convertto",
  "find",
  "format",
  "get",
  "group",
  "measure",
  "resolve",
  "search",
  "select",
  "show",
  "sort",
  "test",
]);

const MEDIUM_RISK_VERBS = new Set([
  "add",
  "copy",
  "enable",
  "export",
  "grant",
  "import",
  "install",
  "move",
  "new",
  "publish",
  "register",
  "rename",
  "set",
  "start",
  "stop",
  "update",
  "write",
]);

const HIGH_RISK_VERBS = new Set([
  "clear",
  "disable",
  "dismount",
  "initialize",
  "remove",
  "reset",
  "restart",
  "revoke",
  "uninstall",
  "unregister",
]);

const DANGEROUS_PATTERNS: Array<{
  pattern: RegExp;
  description: string;
}> = [
  {
    pattern: /\b(?:invoke-expression|iex)\b/i,
    description: "PowerShell dynamic expression execution",
  },
  {
    pattern: /\b(?:add-type|scriptblock\s*::\s*create)\b/i,
    description: "PowerShell runtime code compilation",
  },
  {
    pattern: /\b(?:frombase64string|encodedcommand)\b/i,
    description: "Encoded PowerShell execution",
  },
  {
    pattern: /\b(?:downloadstring|reflection\.assembly)\b/i,
    description: "Remote or reflected PowerShell code loading",
  },
  {
    pattern: /\[[^\]\r\n]+\]\s*::\s*[A-Za-z_]\w*\s*\(/,
    description: "PowerShell .NET member invocation",
  },
  {
    pattern:
      /\$(?:[A-Za-z_][\w:]*|\{[^}]+\})(?:\.[A-Za-z_]\w*|\[[^\]]+\])*\.[A-Za-z_]\w*\s*\(/,
    description: "PowerShell object member invocation",
  },
];

const POWERSHELL_VARIABLE = String.raw`\$(?:[A-Za-z_][\w:]*|\{[^}]+\})(?:\.[A-Za-z_]\w*|\[[^\]]+\])*`;
const POWERSHELL_TYPE_CONSTRAINT = String.raw`(?:\[[^\]\r\n]+\]\s*)*`;
const ASSIGNMENT_TARGET = String.raw`${POWERSHELL_TYPE_CONSTRAINT}${POWERSHELL_VARIABLE}`;
const LEADING_ASSIGNMENT = new RegExp(
  String.raw`^\s*${ASSIGNMENT_TARGET}(?:\s*,\s*${ASSIGNMENT_TARGET})*\s*(?:(?:\?\?|[+*/%-])?=)\s*`,
);

function splitPowerShell(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let depth = 0;

  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed) {
      segments.push(trimmed);
    }
    current = "";
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "`") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote !== null) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      current += char;
      quote = char;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")" || char === "}" || char === "]") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (depth === 0 && (char === ";" || char === "\n" || char === "|")) {
      flush();
      if (char === "|" && command[index + 1] === char) {
        index += 1;
      }
      continue;
    }
    if (depth === 0 && char === "&" && command[index + 1] === "&") {
      flush();
      index += 1;
      continue;
    }
    current += char;
  }
  flush();
  return segments;
}

function tokenizePowerShell(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flush = (): void => {
    if (current) {
      tokens.push(current);
      current = "";
    }
  };

  for (const char of segment) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "`") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return tokens;
}

function normalizeProgram(program: string): string {
  const pathStripped = program.split(/[\\/]/).pop() ?? program;
  if (/\.(?:bat|cmd|ps1|psm1)$/i.test(pathStripped)) {
    return "powershell-script";
  }
  const extensionStripped = pathStripped.replace(/\.exe$/i, "");
  const normalized = extensionStripped.toLowerCase();
  return ALIASES.get(normalized) ?? normalized;
}

function stripLeadingAssignments(segment: string): string {
  let command = segment;
  while (true) {
    const match = command.match(LEADING_ASSIGNMENT);
    if (!match) {
      return command;
    }
    command = command.slice(match[0].length);
  }
}

function parseSegments(command: string): PowerShellSegment[] {
  return splitPowerShell(command).flatMap((raw) => {
    const executable = stripLeadingAssignments(raw);
    const tokens = tokenizePowerShell(executable);
    if (tokens.length === 0) {
      return [];
    }
    return [
      {
        raw: executable,
        program: normalizeProgram(tokens[0]!),
        args: tokens.slice(1),
      },
    ];
  });
}

function classifyPowerShellProgram(segment: PowerShellSegment): {
  risk: Risk;
  reason: string;
  matchType: RiskAssessment["matchType"];
} {
  try {
    const cache = getTrustRuleCache();
    const rule =
      cache.findBaseRisk("host_bash", segment.raw) ??
      cache.findBaseRisk("host_bash", segment.program);
    if (rule) {
      return {
        risk: rule.risk,
        reason: rule.description,
        matchType:
          rule.userModified || rule.origin === "user_defined"
            ? "user_rule"
            : "registry",
      };
    }
  } catch {
    // Tests and startup can classify before the cache is initialized.
  }

  const program = segment.program;
  if (HIGH_RISK_COMMANDS.has(program)) {
    return {
      risk: "high",
      reason: `${program} can execute code or perform destructive system changes`,
      matchType: "registry",
    };
  }
  if (MEDIUM_RISK_COMMANDS.has(program)) {
    return {
      risk: "medium",
      reason: `${program} changes host state`,
      matchType: "registry",
    };
  }
  if (LOW_RISK_COMMANDS.has(program)) {
    return {
      risk: "low",
      reason: `${program} reads or formats host state`,
      matchType: "registry",
    };
  }
  if (program === "cmd" || program === "powershell" || program === "pwsh") {
    return {
      risk: "high",
      reason: `${program} executes an arbitrary nested command`,
      matchType: "registry",
    };
  }

  const separator = program.indexOf("-");
  if (separator > 0) {
    const verb = program.slice(0, separator);
    if (HIGH_RISK_VERBS.has(verb)) {
      return {
        risk: "high",
        reason: `${program} belongs to a destructive PowerShell command family`,
        matchType: "registry",
      };
    }
    if (MEDIUM_RISK_VERBS.has(verb)) {
      return {
        risk: "medium",
        reason: `${program} belongs to a state-changing PowerShell command family`,
        matchType: "registry",
      };
    }
    if (LOW_RISK_VERBS.has(verb)) {
      return {
        risk: "low",
        reason: `${program} belongs to a read-only PowerShell command family`,
        matchType: "registry",
      };
    }
  }

  return classifySegment(
    {
      command: segment.raw,
      program,
      args: segment.args,
      operator: "",
    },
    DEFAULT_COMMAND_REGISTRY,
    "host_bash",
  );
}

function buildActionKeys(segments: PowerShellSegment[]): string[] {
  const programs = [...new Set(segments.map((segment) => segment.program))];
  return programs.map((program) => `action:${program}`);
}

function buildScopeOptions(
  command: string,
  actionKeys: string[],
): ScopeOption[] {
  return [
    { pattern: command, label: command },
    ...actionKeys.map((key) => ({
      pattern: key,
      label: `${key.slice("action:".length)} *`,
    })),
  ];
}

function buildAllowlistOptions(
  command: string,
  actionKeys: string[],
): AllowlistOption[] {
  return [
    {
      label: command,
      description: "This exact PowerShell command",
      pattern: command,
    },
    ...actionKeys.map((key) => {
      const program = key.slice("action:".length);
      return {
        label: `${program} *`,
        description: `Any ${program} PowerShell command`,
        pattern: key,
      };
    }),
  ];
}

function detectDangerousPatterns(command: string): DangerousPattern[] {
  const patterns: DangerousPattern[] = [];
  for (const candidate of DANGEROUS_PATTERNS) {
    const match = command.match(candidate.pattern);
    if (match) {
      patterns.push({
        type: "dangerous_substitution",
        description: candidate.description,
        text: match[0],
      });
    }
  }
  return patterns;
}

function scanPowerShellSyntax(command: string): {
  callOperator: boolean;
  outputRedirection: boolean;
} {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let callOperator = false;
  let outputRedirection = false;

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "`") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ">") {
      outputRedirection = true;
      continue;
    }
    if (
      char === "&" &&
      command[index - 1] !== "&" &&
      command[index + 1] !== "&"
    ) {
      callOperator = true;
    }
  }

  return { callOperator, outputRedirection };
}

function collectWindowsPaths(segments: PowerShellSegment[]): string[] {
  const paths = new Set<string>();
  const add = (candidate: string | undefined): void => {
    if (
      candidate !== undefined &&
      !candidate.includes("$") &&
      !candidate.includes(",") &&
      win32.isAbsolute(candidate)
    ) {
      paths.add(win32.normalize(candidate));
    }
  };

  for (const segment of segments) {
    if (!FILESYSTEM_COMMANDS.has(segment.program)) {
      continue;
    }
    for (let index = 0; index < segment.args.length; index++) {
      const arg = segment.args[index]!;
      const equals = arg.indexOf(":");
      const parameter = (equals > 0 ? arg.slice(0, equals) : arg).toLowerCase();
      if (PATH_PARAMETERS.has(parameter)) {
        if (equals > 0) {
          add(arg.slice(equals + 1));
        } else {
          add(segment.args[index + 1]);
          index += 1;
        }
      } else if (!arg.startsWith("-")) {
        add(arg);
      }
    }
  }
  return [...paths];
}

function commonWindowsDirectory(paths: string[]): string | undefined {
  if (paths.length === 0) {
    return undefined;
  }
  const directories = paths.map((path) => win32.dirname(path));
  const root = win32.parse(directories[0]!).root;
  if (
    directories.some(
      (directory) =>
        win32.parse(directory).root.toLowerCase() !== root.toLowerCase(),
    )
  ) {
    return undefined;
  }
  const relativeParts = directories.map((directory) =>
    directory.slice(root.length).split(win32.sep).filter(Boolean),
  );
  const shared: string[] = [];
  const shortest = Math.min(...relativeParts.map((parts) => parts.length));
  for (let index = 0; index < shortest; index++) {
    const candidate = relativeParts[0]![index]!;
    if (
      relativeParts.every(
        (parts) => parts[index]?.toLowerCase() === candidate.toLowerCase(),
      )
    ) {
      shared.push(candidate);
    } else {
      break;
    }
  }
  return win32.join(root, ...shared);
}

function buildDirectoryScopeOptions(
  paths: string[],
): DirectoryScopeOption[] | undefined {
  if (paths.length === 0) {
    return undefined;
  }
  const ancestor = commonWindowsDirectory(paths);
  const options: DirectoryScopeOption[] = [];
  if (ancestor !== undefined && ancestor !== win32.parse(ancestor).root) {
    options.push({
      scope: `${ancestor}${win32.sep}*`,
      label: `In ${win32.basename(ancestor)}/`,
    });
  }
  options.push({ scope: "everywhere", label: "Everywhere" });
  return options;
}

export class PowerShellRiskClassifier {
  async classify(command: string): Promise<PowerShellRiskAssessment> {
    const trimmed = command.trim();
    if (!trimmed) {
      return {
        riskLevel: "low",
        reason: "Empty command",
        scopeOptions: [],
        allowlistOptions: [],
        actionKeys: [],
        commandCandidates: [],
        dangerousPatterns: [],
        opaqueConstructs: false,
        isComplexSyntax: false,
        matchType: "registry",
      };
    }

    try {
      const fullRule = getTrustRuleCache().findBaseRisk("host_bash", trimmed);
      if (fullRule?.origin === "user_defined") {
        return {
          riskLevel: fullRule.risk,
          reason: fullRule.description,
          scopeOptions: [],
          allowlistOptions: [],
          actionKeys: [],
          commandCandidates: [trimmed],
          dangerousPatterns: [],
          opaqueConstructs: false,
          isComplexSyntax: false,
          matchType: "user_rule",
        };
      }
    } catch {
      // Tests and startup can classify before the cache is initialized.
    }

    const segments = parseSegments(trimmed);
    const resolvedPaths = collectWindowsPaths(segments);
    const actionKeys = buildActionKeys(segments);
    const dangerousPatterns = detectDangerousPatterns(trimmed);
    const syntax = scanPowerShellSyntax(trimmed);
    const opaqueConstructs =
      /\$\(|[{}]|(?:^|\s)\.(?:\s|$)/.test(trimmed) ||
      syntax.callOperator ||
      /\b(?:foreach-object|where-object)\b[^\n]*\{/i.test(trimmed);
    let riskLevel: Risk = segments.length === 0 ? "high" : "low";
    let reason = segments.length === 0 ? "No parseable command segments" : "";
    let matchType: RiskAssessment["matchType"] =
      segments.length === 0 ? "unknown" : "registry";

    for (const segment of segments) {
      const classification = classifyPowerShellProgram(segment);
      if (riskOrd(classification.risk) > riskOrd(riskLevel)) {
        riskLevel = classification.risk;
        reason = classification.reason;
        matchType = classification.matchType;
      } else if (!reason) {
        reason = classification.reason;
        matchType = classification.matchType;
      }
    }

    if (dangerousPatterns.length > 0) {
      riskLevel = "high";
      reason = dangerousPatterns[0]!.description;
      matchType = "registry";
    } else if (opaqueConstructs) {
      riskLevel = maxRisk(riskLevel, "high");
      reason = "PowerShell command contains dynamic script execution";
      matchType = "registry";
    } else if (syntax.outputRedirection) {
      riskLevel = maxRisk(riskLevel, "medium");
      reason = "PowerShell command redirects output";
      matchType = "registry";
    } else if (/\$(?:env:)?[A-Za-z_][\w:]*/.test(trimmed)) {
      riskLevel = maxRisk(riskLevel, "medium");
      reason = "PowerShell command contains variable expansion";
    }

    const scopeOptions = buildScopeOptions(trimmed, actionKeys);
    return {
      riskLevel,
      reason,
      scopeOptions,
      allowlistOptions: buildAllowlistOptions(trimmed, actionKeys),
      actionKeys,
      commandCandidates: [trimmed, ...actionKeys],
      dangerousPatterns,
      opaqueConstructs,
      isComplexSyntax: segments.length > 1 || syntax.outputRedirection,
      directoryScopeOptions: buildDirectoryScopeOptions(resolvedPaths),
      resolvedPaths: resolvedPaths.length > 0 ? resolvedPaths : undefined,
      matchType,
    };
  }
}

export const powerShellRiskClassifier = new PowerShellRiskClassifier();
