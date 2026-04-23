/**
 * IPC route definitions for risk classification.
 *
 * Exposes classify_risk to the assistant daemon over the IPC socket. The
 * assistant sends tool invocation parameters; the handler dispatches to the
 * appropriate classifier and returns a complete ClassificationResult.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

import { parseArgs } from "../risk/arg-parser.js";
import { bashRiskClassifier } from "../risk/bash-risk-classifier.js";
import { DEFAULT_COMMAND_REGISTRY } from "../risk/command-registry.js";
import {
  fileRiskClassifier,
  type FileClassificationContext,
} from "../risk/file-risk-classifier.js";
import type { CommandRiskSpec } from "../risk/risk-types.js";
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
  // File classifier context (pre-resolved by assistant)
  fileContext: z
    .object({
      protectedDir: z.string(),
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
  matchType: string;
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
  isContainerized: boolean,
): Promise<boolean> {
  const parsed = await cachedParse(command);

  if (parsed.segments.length === 0) return false;
  if (parsed.hasOpaqueConstructs) return false;
  if (parsed.dangerousPatterns.length > 0) return false;

  // The workspace root for non-containerized: use workingDir as a reasonable
  // proxy (the assistant sends the actual workspace root via workingDir).
  const workspaceRoot = workingDir;

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

async function handleClassifyRisk(
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
        sandboxAutoApprove = await computeSandboxAutoApprove(
          command,
          workingDir,
          isContainerized,
        );
      }

      // Detect complex syntax
      const parsed = await cachedParse(command);
      let isComplexSyntax = false;
      for (const seg of parsed.segments) {
        const name = seg.program.split("/").pop() ?? seg.program;
        const spec: CommandRiskSpec | undefined = Object.hasOwn(
          DEFAULT_COMMAND_REGISTRY,
          name,
        )
          ? DEFAULT_COMMAND_REGISTRY[
              name as keyof typeof DEFAULT_COMMAND_REGISTRY
            ]
          : undefined;
        if (spec?.complexSyntax) {
          isComplexSyntax = true;
          break;
        }
      }

      // Proxied bash risk cap: when running through the credential proxy,
      // cap High → Medium so proxied commands don't trigger unnecessary prompts.
      let finalRisk = assessment.riskLevel;
      if (params.networkMode === "proxied" && finalRisk === "high") {
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
        deprecatedDir: fileCtx?.actorTokenSigningKeyPath
          ? resolve(fileCtx.actorTokenSigningKeyPath, "..")
          : SENTINEL,
        hooksDir: fileCtx?.hooksDir ?? SENTINEL,
        skillSourceDirs: fileCtx?.skillSourceDirs ?? [],
      };

      const assessment = await fileRiskClassifier.classify(
        { toolName: tool, filePath, workingDir },
        context,
      );

      return {
        risk: assessment.riskLevel,
        reason: assessment.reason,
        scopeOptions: assessment.scopeOptions,
        allowlistOptions: assessment.allowlistOptions,
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

    // ── Unknown tool — fall back to registry lookup at base risk ─────────
    default: {
      return {
        risk: "medium",
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
