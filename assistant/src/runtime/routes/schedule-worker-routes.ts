/**
 * Schedule worker status endpoint.
 *
 * The schedule worker runs as a child process the daemon spawns at startup (so
 * it shows up in `assistant ps` and is torn down on shutdown). This read-only
 * route reports its liveness from the PID file. The `assistant schedules worker
 * status` CLI is a thin IPC client over it.
 */

import { z } from "zod";

import { probeScheduleWorker } from "../../schedule/worker-control.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

const statusResponseSchema = z.object({
  status: z.enum(["running", "not_running"]),
  pid: z.number().optional(),
});

/** Report the schedule worker process liveness from its PID file. */
function scheduleWorkerStatus() {
  const worker = probeScheduleWorker();
  return {
    status: worker.status,
    ...(worker.pid != null ? { pid: worker.pid } : {}),
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "schedules_worker_status",
    endpoint: "schedules/worker/status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: scheduleWorkerStatus,
    summary: "Schedule worker status",
    description: "Reports the schedule worker process liveness.",
    tags: ["system"],
    responseBody: statusResponseSchema,
  },
];
