/**
 * Memory retrieval-eval route — builds blinded A/B judge packets comparing
 * retrieval over two on-disk concept corpora (e.g. a v2 snapshot vs a staged v3
 * wiki) on the same mined historical turns. Drives the corpus-reform eval gate:
 * the packets feed a blind-judge workflow that decides whether the staged wiki
 * retrieves at least as well as the current corpus before cutover.
 *
 * Runs in-daemon (like the other v3 maintenance verbs) because embedding needs
 * the live config + credential store; the work is otherwise read-only over the
 * DB and the two corpus dirs, and writes only the packets/key files.
 */

import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import type { AssistantConfig } from "../../config/types.js";
import { getDb } from "../../memory/db-connection.js";
import { runMemoryEval } from "../../memory/v3-eval/eval-packets.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { ACTOR_PRINCIPALS, type RoutePolicy } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("memory-eval-routes");

const MemoryEvalRunParamsSchema = z.object({
  /** Staged v3 wiki dir (relative to the workspace, or absolute). */
  stagingDir: z.string().min(1),
  /** Read-only v2 snapshot dir (relative to the workspace, or absolute). */
  snapshotDir: z.string().min(1),
  /** Output dir for `packets.json` + `key.json` (relative to the workspace, or absolute). */
  outDir: z.string().min(1),
  turns: z.number().int().positive().optional(),
  perConversationCap: z.number().int().positive().optional(),
  k: z.number().int().positive().optional(),
  dense: z.boolean().optional(),
  seed: z.number().int().optional(),
});

const MemoryEvalRunResultSchema = z.object({
  turnsMined: z.number(),
  packetsWritten: z.number(),
  packetsPath: z.string(),
  keyPath: z.string(),
  snapshotPages: z.number(),
  stagingPages: z.number(),
  dense: z.boolean(),
});
export type MemoryEvalRunResult = z.infer<typeof MemoryEvalRunResultSchema>;

/**
 * Build the eval packets. `config` is injectable for tests; production resolves
 * the live config (and through it the embedding backend + DB).
 */
export async function handleMemoryEvalRun(
  body: unknown,
  config: AssistantConfig = getConfig(),
): Promise<MemoryEvalRunResult> {
  const params = MemoryEvalRunParamsSchema.parse(body ?? {});
  const result = await runMemoryEval(params, {
    config,
    workspaceDir: getWorkspaceDir(),
    db: getDb(),
  });
  log.info(result, "memory eval packets written");
  return result;
}

const WRITE_POLICY: RoutePolicy = {
  requiredScopes: ["settings.write"],
  allowedPrincipalTypes: ACTOR_PRINCIPALS,
};

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "memory_eval_run",
    method: "POST",
    policy: WRITE_POLICY,
    endpoint: "memory/eval/run",
    handler: ({ body }) => handleMemoryEvalRun(body),
    summary:
      "Build blinded A/B retrieval-eval packets over two concept corpora (snapshot vs staged wiki)",
    tags: ["memory"],
    requestBody: MemoryEvalRunParamsSchema,
    responseBody: MemoryEvalRunResultSchema,
  },
];
