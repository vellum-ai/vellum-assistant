/**
 * Daemon-side process status endpoint (GET /v1/ps).
 *
 * Walks the OS process tree rooted at the daemon (`process.pid`) and reports
 * every descendant process that is actually parented to it — qdrant, the
 * embed worker, the memory worker (when the daemon owns it), MCP servers, and
 * any other live children. The tree is built from the native process table
 * (`/proc` on Linux, `ps` on macOS), so it reflects reality rather than a
 * hard-coded subsystem list.
 */

import { z } from "zod";

import { getLogger } from "../../util/logger.js";
import {
  buildProcessTree,
  listProcesses,
  type ProcTreeNode,
} from "../../util/process-tree.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("ps-routes");

type ProcessStatus = "running" | "not_running" | "unreachable";

interface ProcessEntry {
  name: string;
  status: ProcessStatus;
  children?: ProcessEntry[];
  info?: string;
}

const processEntrySchema: z.ZodType<ProcessEntry> = z
  .lazy(() =>
    z.object({
      name: z.string(),
      status: z.enum(["running", "not_running", "unreachable"]),
      children: z.array(processEntrySchema).optional(),
      info: z.string().optional(),
    }),
  )
  .meta({ id: "ProcessEntry" });

const psResponseSchema = z.object({
  processes: z.array(processEntrySchema),
});

/** Map a native process-tree node onto the wire `ProcessEntry` shape. */
function toEntry(node: ProcTreeNode): ProcessEntry {
  const entry: ProcessEntry = {
    name: node.name,
    // Every node in the walk is a live process by definition.
    status: "running",
    info: `pid ${node.pid}`,
  };
  if (node.children.length > 0) {
    entry.children = node.children.map(toEntry);
  }
  return entry;
}

async function getProcessStatus() {
  let entry: ProcessEntry;
  try {
    const procs = await listProcesses();
    entry = toEntry(buildProcessTree(procs, process.pid));
  } catch (err) {
    // Enumeration failed (no /proc and `ps` unavailable). Still report the
    // daemon itself so the endpoint stays useful for liveness.
    log.warn({ err }, "Failed to enumerate process tree");
    entry = {
      name: "assistant",
      status: "running",
      info: `pid ${process.pid}`,
    };
  }

  return { processes: [entry] };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "ps",
    endpoint: "ps",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: getProcessStatus,
    summary: "Process status",
    description:
      "Returns the daemon's process tree: every descendant process parented to the assistant runtime, built from the native OS process table.",
    tags: ["system"],
    responseBody: psResponseSchema,
  },
];
