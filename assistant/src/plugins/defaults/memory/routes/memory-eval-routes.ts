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

import { getConfig } from "../../../../config/loader.js";
import type { AssistantConfig } from "../../../../config/types.js";
import { getDb } from "../../../../persistence/db-connection.js";
import {
  ACTOR_PRINCIPALS,
  type RoutePolicy,
} from "../../../../runtime/auth/route-policy.js";
import type { RouteDefinition } from "../../../../runtime/routes/types.js";
import { getLogger } from "../../../../util/logger.js";
import { getWorkspaceDir } from "../../../../util/platform.js";
import { runMemoryEval } from "../v3-eval/eval-packets.js";
import { type TallyResult, tallyVerdicts } from "../v3-eval/eval-tally.js";

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
  /** Pin the exact turns to re-mine (turn ids from a prior key.json/packets.json). */
  turnIds: z.array(z.string()).optional(),
  /** Conversations to omit from recency mining (e.g. the migration's own chat). */
  excludeConversationIds: z.array(z.string()).optional(),
});

const MemoryEvalRunResultSchema = z.object({
  turnsMined: z.number(),
  turnsRequested: z.number(),
  packetsWritten: z.number(),
  packetsPath: z.string(),
  keyPath: z.string(),
  metaPath: z.string(),
  snapshotPages: z.number(),
  stagingPages: z.number(),
  dense: z.boolean(),
  seed: z.number(),
  k: z.number(),
  embedding: z.object({
    provider: z.string(),
    model: z.string(),
    dims: z.number().nullable(),
  }),
  turnIds: z.array(z.string()),
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
  if (result.turnsMined < result.turnsRequested) {
    log.warn(
      { requested: result.turnsRequested, mined: result.turnsMined },
      "Fewer eval turns mined than requested — pinned turns may have been " +
        "deleted, or there are too few recent user turns",
    );
  }
  log.info(result, "memory eval packets written");
  return result;
}

const MemoryEvalTallyParamsSchema = z.object({
  /** Judge verdicts (one or more per turn for a panel); winner derived from scores if absent. */
  verdicts: z.array(
    z.object({
      turn: z.string(),
      winner: z.string().optional(),
      scoreA: z.number(),
      scoreB: z.number(),
    }),
  ),
  /** The per-turn A/B → snapshot/staging unblinding map from `eval` (key.json). */
  key: z.array(
    z.object({
      turn: z.string(),
      a: z.enum(["snapshot", "staging"]),
      b: z.enum(["snapshot", "staging"]),
    }),
  ),
  /** Sign-test significance threshold (default 0.05). */
  alpha: z.number().positive().optional(),
});

const MemoryEvalTallyResultSchema = z.object({
  turns: z.number(),
  verdictsCounted: z.number(),
  unmatchedVerdicts: z.number(),
  panel: z.object({ min: z.number(), max: z.number(), mean: z.number() }),
  snapshotWins: z.number(),
  stagingWins: z.number(),
  ties: z.number(),
  decided: z.number(),
  meanSnapshot: z.number(),
  meanStaging: z.number(),
  signTestP: z.number(),
  verdict: z.enum(["wiki-wins", "tie", "wiki-loses"]),
  gate: z.enum(["pass", "fail"]),
  confident: z.boolean(),
  notes: z.array(z.string()),
});
export type MemoryEvalTallyResult = z.infer<typeof MemoryEvalTallyResultSchema>;

/**
 * Pure: join the judge verdicts to the unblinding key and return the noise-aware
 * gate verdict. The CLI reads the verdicts/key files and passes the arrays.
 */
export function handleMemoryEvalTally(body: unknown): MemoryEvalTallyResult {
  const params = MemoryEvalTallyParamsSchema.parse(body ?? {});
  const result: TallyResult = tallyVerdicts(
    params.verdicts,
    params.key,
    params.alpha !== undefined ? { alpha: params.alpha } : {},
  );
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
  {
    operationId: "memory_eval_tally",
    method: "POST",
    policy: WRITE_POLICY,
    endpoint: "memory/eval/tally",
    handler: ({ body }) => handleMemoryEvalTally(body),
    summary:
      "Unblind + tally blind-judge verdicts against the key with a noise-aware win/tie/loss verdict",
    tags: ["memory"],
    requestBody: MemoryEvalTallyParamsSchema,
    responseBody: MemoryEvalTallyResultSchema,
  },
];
