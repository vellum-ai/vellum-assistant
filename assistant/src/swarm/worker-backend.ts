import type { SwarmRole } from "./types.js";

/**
 * Profile names that scope tool access for worker tasks.
 */
export type WorkerProfile = "general" | "researcher" | "coder" | "reviewer";

/**
 * Maps swarm roles to worker profiles.
 */
export function roleToProfile(role: SwarmRole): WorkerProfile {
  switch (role) {
    case "researcher":
      return "researcher";
    case "coder":
      return "coder";
    case "reviewer":
      return "reviewer";
    case "router":
      return "general";
    default:
      return "general";
  }
}

/**
 * Per-profile tool access policy. The sets are checked in order:
 * 1. If tool is in `deny`, block unconditionally.
 * 2. If tool is in `allow`, auto-approve.
 * 3. If tool is in `approvalRequired`, prompt user.
 * 4. Otherwise follow default approval flow.
 */
export interface ProfilePolicy {
  allow: Set<string>;
  deny: Set<string>;
  approvalRequired: Set<string>;
}

const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "LS",
  "Bash(grep *)",
  "Bash(rg *)",
  "Bash(find *)",
]);

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Return the tool access policy for a given profile.
 */
export function getProfilePolicy(profile: WorkerProfile): ProfilePolicy {
  switch (profile) {
    case "general":
      return {
        allow: new Set(READ_ONLY_TOOLS),
        deny: new Set(),
        approvalRequired: new Set(["Bash", ...WRITE_TOOLS]),
      };

    case "researcher":
      return {
        allow: new Set(READ_ONLY_TOOLS),
        deny: new Set([...WRITE_TOOLS, "Bash"]),
        approvalRequired: new Set(),
      };

    case "coder":
      return {
        allow: new Set(READ_ONLY_TOOLS),
        deny: new Set(),
        approvalRequired: new Set(["Bash", ...WRITE_TOOLS]),
      };

    case "reviewer":
      return {
        allow: new Set(READ_ONLY_TOOLS),
        deny: new Set([...WRITE_TOOLS, "Bash"]),
        approvalRequired: new Set(),
      };

    default:
      return {
        allow: new Set(READ_ONLY_TOOLS),
        deny: new Set(),
        approvalRequired: new Set(["Bash", ...WRITE_TOOLS]),
      };
  }
}

// ---------------------------------------------------------------------------
// Worker Backend
// ---------------------------------------------------------------------------

export type WorkerFailureReason =
  | "backend_unavailable"
  | "timeout"
  | "cancelled"
  | "malformed_output"
  | "tool_denied";

export interface SwarmWorkerBackendResult {
  success: boolean;
  output: string;
  failureReason?: WorkerFailureReason;
  durationMs: number;
}

export interface SwarmWorkerBackendInput {
  prompt: string;
  profile: WorkerProfile;
  workingDir: string;
  modelIntent?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Abstraction over execution backends for swarm workers.
 */
export interface SwarmWorkerBackend {
  readonly name: string;
  /** Check whether the backend is available (e.g. API key present). */
  isAvailable(): boolean | Promise<boolean>;
  /** Run a task with the given input. */
  runTask(input: SwarmWorkerBackendInput): Promise<SwarmWorkerBackendResult>;
}
