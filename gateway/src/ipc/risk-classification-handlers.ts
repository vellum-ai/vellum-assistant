/**
 * IPC route definitions for risk classification.
 *
 * Exposes classify_risk to the assistant daemon over the IPC socket. The
 * assistant sends tool invocation parameters; the handler dispatches to the
 * appropriate classifier and returns a complete ClassificationResult.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

import { parseArgs } from "../risk/arg-parser.js";
import {
  bashRiskClassifier,
  getWrappedProgramWithArgs,
} from "../risk/bash-risk-classifier.js";
import { DEFAULT_COMMAND_REGISTRY } from "../risk/command-registry.js";
import { generateDirectoryScopeOptions } from "../risk/directory-scope.js";
import {
  fileRiskClassifier,
  type FileClassificationContext,
} from "../risk/file-risk-classifier.js";
import type {
  CommandRiskSpec,
  DirectoryScopeOption,
} from "../risk/risk-types.js";
import { scheduleRiskClassifier } from "../risk/schedule-risk-classifier.js";
import {
  analyzeShellCommand,
  cachedParse,
  deriveShellActionKeys,
} from "../risk/shell-identity.js";
import { skillLoadRiskClassifier } from "../risk/skill-risk-classifier.js";
import { webRiskClassifier } from "../risk/web-risk-classifier.js";
import type { IpcRoute } from "./server.js";

// ── Zod schema ──────────────────────────────────────────────────────────────

const ClassifyRiskSchema = z.object({
  tool: z.string().min(1),
  command: z.string().optional(),
  url: z.string().optional(),
  path: z.string().optional(),
  skill: z.string().optional(),
  mode: z.string().optional(),
  script: z.string().optional(),
  workingDir: z.string().optional(),
  allowPrivateNetwork: z.boolean().optional(),
  networkMode: z.string().optional(),
  isContainerized: z.boolean().optional(),
  workspaceRoot: z.string().optional(),
  // File classifier context (pre-resolved by assistant)
  fileContext: z
    .object({
      protectedDir: z.string(),
      deprecatedDir: z.string(),
      hooksDir: z.string(),
      actorTokenSigningKeyPath: z.string(),
      skillSourceDirs: z.array(z.string()),
    })
    .optional(),
  // Skill classifier context (pre-resolved by assistant)
  skillMetadata: z
    .object({
      skillId: z.string(),
      selector: z.string(),
      versionHash: z.string(),
      transitiveHash: z.string().optional(),
      hasInlineExpansions: z.boolean(),
      isDynamic: z.boolean(),
    })
    .optional(),
  /** Tool registry default risk level for unknown tools. */
  registryDefaultRisk: z.string().optional(),
});

type ClassifyRiskParams = z.infer<typeof ClassifyRiskSchema>;

// ── Result type ─────────────────────────────────────────────────────────────

interface ClassificationResult {
  risk: string;
  reason: string;
  scopeOptions: Array<{ pattern: string; label: string }>;
  allowlistOptions?: Array<{
    label: string;
    description: string;
    pattern: string;
  }>;
  actionKeys?: string[];
  commandCandidates?: string[];
  dangerousPatterns?: Array<{
    type: string;
    description: string;
    text: string;
  }>;
  opaqueConstructs?: boolean;
  isComplexSyntax?: boolean;
  sandboxAutoApprove?: boolean;
  directoryScopeOptions?: DirectoryScopeOption[];
  matchType: string;
}

// ── Registry spec lookup ────────────────────────────────────────────────────

/**
 * Look up a `CommandRiskSpec` by program name, stripping any path prefix
 * (e.g. `/usr/bin/rm` → `rm`). Uses `Object.hasOwn` so prototype entries
 * like `toString` don't spuriously match.
 */
function lookupSpec(program: string): CommandRiskSpec | undefined {
  const name = program.split("/").pop() ?? program;
  return Object.hasOwn(DEFAULT_COMMAND_REGISTRY, name)
    ? DEFAULT_COMMAND_REGISTRY[name as keyof typeof DEFAULT_COMMAND_REGISTRY]
    : undefined;
}

// ── Path-within-workspace check ─────────────────────────────────────────────

function isPathWithinRoot(filePath: string, root: string): boolean {
  if (!filePath || !root) return false;
  const normalizedRoot = root.endsWith("/") ? root : root + "/";
  const normalizedPath = resolve(filePath);
  return (
    normalizedPath === root.replace(/\/$/, "") ||
    normalizedPath.startsWith(normalizedRoot)
  );
}

// ── Sandbox auto-approve ────────────────────────────────────────────────────

async function computeSandboxAutoApprove(
  command: string,
  workingDir: string,
  workspaceRoot: string,
  isContainerized: boolean,
): Promise<boolean> {
  const parsed = await cachedParse(command);

  if (parsed.segments.length === 0) return false;
  if (parsed.hasOpaqueConstructs) return false;
  if (parsed.dangerousPatterns.length > 0) return false;

  return parsed.segments.every((seg) => {
    const name = seg.program.split("/").pop() ?? seg.program;
    const spec: CommandRiskSpec | undefined = Object.hasOwn(
      DEFAULT_COMMAND_REGISTRY,
      name,
    )
      ? DEFAULT_COMMAND_REGISTRY[name as keyof typeof DEFAULT_COMMAND_REGISTRY]
      : undefined;
    if (!spec?.sandboxAutoApprove) return false;

    // Containerized: entire fs is workspace, skip path checks
    if (isContainerized) return true;

    // Non-containerized: parse args and check all path args against workspace
    const schema = spec.argSchema ?? {};
    const parsedArgs = parseArgs(seg.args, schema);

    // If no path args, auto-approve (operating on cwd/stdin which is workspace)
    if (parsedArgs.pathArgs.length === 0) return true;

    // All path args must resolve within workspace
    return parsedArgs.pathArgs.every((p) => {
      if (p === "~" || p.startsWith("~/")) {
        const expanded = p === "~" ? homedir() : join(homedir(), p.slice(2));
        return isPathWithinRoot(expanded, workspaceRoot);
      }
      if (p.startsWith("~")) {
        return false;
      }
      const resolved = p.startsWith("/") ? p : resolve(workingDir, p);
      return isPathWithinRoot(resolved, workspaceRoot);
    });
  });
}

// ── Handler ─────────────────────────────────────────────────────────────────

export async function handleClassifyRisk(
  params: ClassifyRiskParams,
): Promise<ClassificationResult> {
  const tool = params.tool;

  switch (tool) {
    // ── Bash / host_bash ──────────────────────────────────────────────────
    case "bash":
    case "host_bash": {
      const command = params.command ?? "";
      const workingDir = params.workingDir ?? process.cwd();
      const isContainerized = params.isContainerized ?? false;

      const assessment = await bashRiskClassifier.classify({
        command,
        toolName: tool,
        workingDir,
      });

      // Derive action keys and build command candidates for trust rule matching.
      // Command candidates include the raw command, the canonical primary
      // segment (if different), and the action keys themselves.
      const analysis = await analyzeShellCommand(command);
      const actionResult = deriveShellActionKeys(analysis);
      const actionKeys = actionResult.keys.map((k) => k.key);

      const candidateSet = new Set<string>();
      if (command.trim()) candidateSet.add(command.trim());
      if (actionResult.isSimpleAction && actionResult.primarySegment) {
        const canonical = actionResult.primarySegment.command;
        if (canonical !== command.trim()) candidateSet.add(canonical);
      }
      for (const key of actionKeys) {
        candidateSet.add(key);
      }
      const commandCandidates = [...candidateSet];

      // Compute sandbox auto-approve for "bash" tool only
      let sandboxAutoApprove = false;
      if (tool === "bash") {
        const wsRoot = params.workspaceRoot ?? workingDir;
        sandboxAutoApprove = await computeSandboxAutoApprove(
          command,
          workingDir,
          wsRoot,
          isContainerized,
        );
      }

      // Detect complex syntax and collect filesystem-op path args for the
      // directory scope ladder. Walks every segment left-to-right, tracking
      // a per-segment "current cwd" that advances through simple `cd <dir>`
      // segments so relative path args in later segments resolve against
      // the right directory (e.g. `cd /tmp && rm foo` scopes `foo` to
      // `/tmp/foo`, not `<initial workingDir>/foo`).
      //
      // For bare filesystem-op segments (filesystemOp=true with no resolved
      // pathArgs, e.g. a lone `ls`), capture the segment's current cwd as a
      // pathArg so the emitted scope reflects where that segment actually
      // ran — not where a later `cd` segment moved to. This keeps
      // `ls && cd /tmp` scoped to the original workingDir rather than /tmp.
      //
      // Wrapper segments (e.g. `sudo rm -rf foo`, `env cp a b`) are unwrapped
      // before the filesystem-op check so the inner command's spec and
      // argSchema are used. Wrappers in non-exec modes (e.g. `command -v rm`,
      // `timeout --help rm`) are NOT unwrapped — they look up or print help
      // for the inner program rather than executing it, so the inner
      // program's filesystemOp flag must not apply.
      const parsed = await cachedParse(command);
      let isComplexSyntax = false;
      let hasFilesystemOp = false;
      const fsPathArgs = new Set<string>();
      let trackedCwd = workingDir;
      for (const seg of parsed.segments) {
        // Unwrap wrappers iteratively so `sudo sudo rm foo` and
        // `env sudo rm foo` both resolve to the innermost `rm`.
        //
        // Mirror `classifySegment` in bash-risk-classifier.ts: if the
        // wrapper's first arg is in its `nonExecFlags`, the wrapper is in
        // lookup/help mode and does NOT execute the inner command — stop
        // unwrapping so the inner program's spec (and filesystemOp flag)
        // does not bleed through.
        let effectiveProgram = seg.program;
        let effectiveArgs = seg.args;
        let effectiveSpec = lookupSpec(effectiveProgram);
        const visited = new Set<string>();
        while (
          effectiveSpec?.isWrapper &&
          !visited.has(effectiveProgram)
        ) {
          visited.add(effectiveProgram);
          const isNonExecMode =
            effectiveSpec.nonExecFlags !== undefined &&
            effectiveArgs.length > 0 &&
            effectiveSpec.nonExecFlags.includes(effectiveArgs[0]!);
          if (isNonExecMode) break;
          const inner = getWrappedProgramWithArgs({
            program: effectiveProgram,
            args: effectiveArgs,
          });
          if (!inner) break;
          effectiveProgram = inner.program;
          effectiveArgs = inner.args;
          effectiveSpec = lookupSpec(effectiveProgram);
        }

        if (effectiveSpec?.complexSyntax) {
          isComplexSyntax = true;
        }
        if (effectiveSpec?.filesystemOp === true) {
          hasFilesystemOp = true;
          const parsedArgs = parseArgs(
            effectiveArgs,
            effectiveSpec.argSchema ?? {},
          );
          if (parsedArgs.pathArgs.length === 0) {
            // Bare filesystem-op segment (e.g. `ls`, `pwd`). Anchor the
            // scope to the cwd AS-OF THIS SEGMENT so a later `cd` doesn't
            // shift the scope away from where the segment actually ran.
            fsPathArgs.add(trackedCwd);
          } else {
            for (const p of parsedArgs.pathArgs) {
              // Pre-resolve relative path args against the current tracked
              // cwd so scope ladder ancestors reflect cd-induced dir changes.
              // Keep `~` / `~/...` as-is — `generateDirectoryScopeOptions`
              // expands them itself and the tracked cwd doesn't affect that.
              if (p === "~" || p.startsWith("~/") || p.startsWith("~")) {
                fsPathArgs.add(p);
              } else if (isAbsolute(p)) {
                fsPathArgs.add(p);
              } else {
                fsPathArgs.add(resolve(trackedCwd, p));
              }
            }
          }
        }

        // Advance tracked cwd for simple `cd <dir>` segments. Bail out
        // (keep the current tracked cwd) for `cd` with no args, `cd -`,
        // or `cd ~` forms — those require runtime state we don't have.
        if (effectiveProgram === "cd") {
          const positionals = effectiveArgs.filter((a) => !a.startsWith("-"));
          if (positionals.length === 1) {
            const target = positionals[0]!;
            if (target === "-" || target === "~" || target.startsWith("~")) {
              // Unsupported form — leave trackedCwd unchanged.
            } else if (isAbsolute(target)) {
              trackedCwd = resolve(target);
            } else {
              trackedCwd = resolve(trackedCwd, target);
            }
          }
        }
      }

      // Emit directory scope ladder only when at least one segment is a
      // filesystem op. Pass the ORIGINAL `workingDir` (not the final
      // `trackedCwd`) — each filesystem-op segment has already contributed
      // its effective cwd into `fsPathArgs` (bare segments pushed their
      // at-the-time cwd; non-bare segments pre-resolved relative args against
      // their at-the-time cwd), so the generator does not need the final
      // trackedCwd to reflect per-segment cd progress.
      let directoryScopeOptions: DirectoryScopeOption[] | undefined;
      if (hasFilesystemOp) {
        directoryScopeOptions = generateDirectoryScopeOptions({
          pathArgs: [...fsPathArgs],
          workingDir,
          workspaceRoot: params.workspaceRoot,
        });
      }

      // Proxied bash risk cap: when running through the credential proxy,
      // cap High → Medium so proxied commands don't trigger unnecessary prompts.
      // Only applies to sandboxed "bash" — host_bash runs on the host machine
      // and should not have its risk capped.
      let finalRisk = assessment.riskLevel;
      if (
        tool === "bash" &&
        params.networkMode === "proxied" &&
        finalRisk === "high"
      ) {
        finalRisk = "medium";
      }

      return {
        risk: finalRisk,
        reason: assessment.reason,
        scopeOptions: assessment.scopeOptions,
        allowlistOptions: assessment.allowlistOptions,
        actionKeys,
        commandCandidates,
        dangerousPatterns: analysis.dangerousPatterns,
        opaqueConstructs: analysis.hasOpaqueConstructs,
        isComplexSyntax,
        sandboxAutoApprove,
        directoryScopeOptions,
        matchType: assessment.matchType,
      };
    }

    // ── File tools ────────────────────────────────────────────────────────
    case "file_read":
    case "file_write":
    case "file_edit":
    case "host_file_read":
    case "host_file_write":
    case "host_file_edit": {
      const filePath = params.path ?? "";
      const workingDir = params.workingDir ?? process.cwd();

      // Build FileClassificationContext from the IPC params.
      // When fileContext is not provided, use impossible sentinel paths so the
      // classifier never produces false-positive escalations (an empty string
      // for hooksDir would normalize to "/" and match every path).
      const SENTINEL = "/__vellum_no_context__";
      const fileCtx = params.fileContext;
      const context: FileClassificationContext = {
        protectedDir: fileCtx?.protectedDir ?? SENTINEL,
        deprecatedDir: fileCtx?.deprecatedDir ?? SENTINEL,
        hooksDir: fileCtx?.hooksDir ?? SENTINEL,
        skillSourceDirs: fileCtx?.skillSourceDirs ?? [],
      };

      const assessment = await fileRiskClassifier.classify(
        { toolName: tool, filePath, workingDir },
        context,
      );

      // File tools always emit a directory scope ladder: either the filePath's
      // parent (when provided) or the working directory as the ancestor.
      const directoryScopeOptions = generateDirectoryScopeOptions({
        pathArgs: filePath ? [filePath] : [],
        workingDir,
        workspaceRoot: params.workspaceRoot,
      });

      return {
        risk: assessment.riskLevel,
        reason: assessment.reason,
        scopeOptions: assessment.scopeOptions,
        allowlistOptions: assessment.allowlistOptions,
        directoryScopeOptions,
        matchType: assessment.matchType,
      };
    }

    // ── Web tools ─────────────────────────────────────────────────────────
    case "web_fetch":
    case "network_request":
    case "web_search": {
      const assessment = await webRiskClassifier.classify({
        toolName: tool,
        url: params.url,
        allowPrivateNetwork: params.allowPrivateNetwork,
      });

      return {
        risk: assessment.riskLevel,
        reason: assessment.reason,
        scopeOptions: assessment.scopeOptions,
        allowlistOptions: assessment.allowlistOptions,
        matchType: assessment.matchType,
      };
    }

    // ── Skill tools ───────────────────────────────────────────────────────
    case "skill_load":
    case "scaffold_managed_skill":
    case "delete_managed_skill": {
      const assessment = await skillLoadRiskClassifier.classify({
        toolName: tool,
        skillSelector: params.skill,
        resolvedMetadata: params.skillMetadata
          ? {
              skillId: params.skillMetadata.skillId,
              selector: params.skillMetadata.selector,
              versionHash: params.skillMetadata.versionHash,
              transitiveHash: params.skillMetadata.transitiveHash,
              hasInlineExpansions: params.skillMetadata.hasInlineExpansions,
              isDynamic: params.skillMetadata.isDynamic,
            }
          : undefined,
      });

      return {
        risk: assessment.riskLevel,
        reason: assessment.reason,
        scopeOptions: assessment.scopeOptions,
        allowlistOptions: assessment.allowlistOptions,
        matchType: assessment.matchType,
      };
    }

    // ── Schedule tools ────────────────────────────────────────────────────
    case "schedule_create":
    case "schedule_update": {
      const assessment = await scheduleRiskClassifier.classify({
        toolName: tool,
        mode: params.mode,
        script: params.script,
      });

      return {
        risk: assessment.riskLevel,
        reason: assessment.reason,
        scopeOptions: assessment.scopeOptions,
        allowlistOptions: assessment.allowlistOptions,
        matchType: assessment.matchType,
      };
    }

    // ── Unknown tool — use registry default risk level if provided ──────
    default: {
      return {
        risk: params.registryDefaultRisk ?? "medium",
        reason: `Unknown tool: ${tool}`,
        scopeOptions: [],
        matchType: "unknown",
      };
    }
  }
}

// ── Route export ────────────────────────────────────────────────────────────

export const riskClassificationRoutes: IpcRoute[] = [
  {
    method: "classify_risk",
    schema: ClassifyRiskSchema,
    handler: (params?: Record<string, unknown>) => {
      return handleClassifyRisk(params as ClassifyRiskParams);
    },
  },
];
