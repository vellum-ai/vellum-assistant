// ---------------------------------------------------------------------------
// Memory v2 — daemon-startup helpers
// ---------------------------------------------------------------------------
//
// Small focused module that holds the gating + dispatch logic for v2-specific
// startup work invoked from `lifecycle.ts` (and, for the post-credential
// capability reseed, from the secrets route). Lives in its own file so the unit
// test for the gate does not have to mount the entire lifecycle import graph.

import type { AssistantConfig } from "../../../../config/schema.js";
import { getWorkspaceDir } from "../../../../util/platform.js";
import { getLogger } from "../logging.js";

const log = getLogger("memory-v2-startup");

/**
 * Fire-and-forget seed of the v2 skill entries (now indexed alongside concept
 * pages in `memory_v2_concept_pages` under the `skills/<id>` slug prefix), and
 * a one-shot best-effort cleanup of the legacy `memory_v2_skills` Qdrant
 * collection. Uses a dynamic import so v2 code does not load unless the gate
 * passes. Never awaits — startup must not block on this (see
 * `assistant/CLAUDE.md` daemon startup philosophy).
 */
export function maybeSeedMemoryV2Skills(config: AssistantConfig): void {
  if (!config.memory.v2.enabled) return;
  void import("./skill-store.js")
    .then(({ seedV2SkillEntries }) => seedV2SkillEntries())
    .catch((err) => log.warn({ err }, "Failed to seed v2 skill entries"));
  void import("./qdrant.js")
    .then(({ dropLegacySkillsCollection }) => dropLegacySkillsCollection())
    .catch((err) =>
      log.warn(
        { err },
        "Failed to drop legacy memory_v2_skills collection — non-fatal",
      ),
    );
}

/**
 * Fire-and-forget seed of the v2 CLI-subcommand entries (indexed alongside
 * concept pages and skills in `memory_v2_concept_pages` under the
 * `cli-commands/<name>` slug prefix). Dynamic import keeps v2 code out of the
 * startup graph when the gate is off. Never awaits — startup must not block.
 */
export function maybeSeedMemoryV2CliCommands(config: AssistantConfig): void {
  if (!config.memory.v2.enabled) return;
  void import("./cli-command-store.js")
    .then(({ seedV2CliCommandEntries }) => seedV2CliCommandEntries())
    .catch((err) => log.warn({ err }, "Failed to seed v2 CLI-command entries"));
}

/**
 * Default upper bound on how long
 * {@link maybeReseedCapabilitiesAfterManagedCredential} waits for the capability
 * reseeds before enqueuing the v3 maintain pass. The reseeds keep running
 * detached past this bound — it only stops the barrier from waiting on a wedged
 * catalog (a stalled `getCatalog()` or a managed-proxy embed that never
 * returns). A straggler that finishes later re-enqueues maintain.
 */
const RESEED_BARRIER_TIMEOUT_MS = 120_000;

/**
 * Resolve to `true` if `p` settles within `ms`, or `false` if the timeout wins.
 * Always clears the timer, so a `p` that settles first leaves no pending timer
 * keeping the event loop (or a test) alive.
 */
async function settledWithin(
  p: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([p.then(() => true), timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Re-seed the v2 skill and CLI-command capability entries once a managed-proxy
 * credential lands, closing the first-boot race where the daemon's startup seed
 * runs before the platform has provisioned the managed embedding credential.
 *
 * On a brand-new managed assistant the memory worker fires the startup seed
 * (`maybeSeedMemoryV2Skills` / `maybeSeedMemoryV2CliCommands`) seconds after
 * boot, but the platform pushes `vellum:assistant_api_key` (the credential the
 * managed Gemini embedding backend needs) tens of seconds later. The seed's
 * `embedWithBackend` call throws `EmbeddingBackendUnavailableError` before the
 * skill/CLI `entries` cache is replaced, so `listSkillEntries()` /
 * `listCliCommandEntries()` stay empty and the synthetic `skills/<id>` and
 * `cli-commands/<name>` rows never reach the page index — leaving the v3 needle
 * finder lane and always-candidate skill pinning with nothing to surface until
 * the next daemon restart. Re-running the seed when the credential arrives
 * restores the capability pages without a restart.
 *
 * Gated on the managed-proxy prerequisites now being satisfied (both the
 * platform base URL and the assistant API key present) so a non-managed
 * credential write — or a partial update that has not yet completed the pair —
 * does not kick a doomed embed. Idempotent: `seedV2SkillEntries` /
 * `seedV2CliCommandEntries` atomically replace their caches, so a redundant
 * reseed (the startup seed already succeeded) is cheap and harmless. The two
 * catalogs are independent, so they reseed in parallel. Callers invoke this
 * detached (`void`) — it must not block the credential-store response.
 *
 * Reseeding alone only repopulates the shared page index — v3 reads its
 * synthetic capability rows from the v2 stores, but its memoized lanes and its
 * `memory_v3_sections` dense store refresh only on the v3 maintain pass (6-hour
 * backstop). So when v3 is live, enqueue a `memory_v3_maintain` job after the
 * reseed: its capability-reconcile stage embeds the freshly-seeded rows into the
 * dense store and its lane-invalidation stage forces a rebuild against the now-
 * populated index, so v3 surfaces the skill/CLI pages within seconds instead of
 * waiting out the backstop.
 *
 * The maintain enqueue must NOT be gated on both catalogs settling. The two
 * embeds are independent, and a single wedged catalog (a stalled `getCatalog()`
 * or a managed-proxy embed that never returns) would otherwise block the v3 lane
 * rebuild indefinitely, so the catalog that DID seed never reaches the selector.
 * The barrier is therefore bounded by `reseedTimeoutMs`: maintain is enqueued
 * once the barrier resolves (the pass is idempotent and reconciles whatever the
 * page index currently holds), and a straggler catalog that finishes after the
 * timeout re-enqueues maintain so its late rows are picked up without waiting out
 * the backstop.
 *
 * `reseedTimeoutMs` is injectable for tests; production uses
 * {@link RESEED_BARRIER_TIMEOUT_MS}.
 */
export async function maybeReseedCapabilitiesAfterManagedCredential(
  config: AssistantConfig,
  opts: { reseedTimeoutMs?: number } = {},
): Promise<void> {
  if (!config.memory.v2.enabled) return;

  const { hasManagedProxyPrereqs } =
    await import("../../../../providers/platform-proxy/context.js");
  if (!(await hasManagedProxyPrereqs())) return;

  // The managed credential has just landed, so the embedding backend is now
  // reachable. Retry the embedding-identity reconcile to close the
  // fresh-platform-install-booted-with-Gemini-down case: the first boot defers
  // (degraded) because the backend probe returns null, and this credential-
  // arrival retry commits the collection dimension once the backend answers.
  // Run to COMPLETION before launching the reseeds below: the reconcile's
  // commit-fresh/migrate may create or destroy+recreate the concept-page
  // collection, and the reseeds embed + upsert into it — settling the
  // collection dimension first stops a recreate from wiping freshly-seeded
  // points or upserting at a stale dimension. Contained so a reconcile failure
  // never rejects the detached caller.
  try {
    const { reconcileEmbeddingIdentity } =
      await import("../../../../daemon/embedding-reconcile.js");
    await reconcileEmbeddingIdentity(config);
  } catch (err) {
    log.warn(
      { err },
      "Embedding-identity reconcile after managed proxy credential update threw — continuing",
    );
  }

  // Skills and CLI commands are independent catalogs sharing the unified
  // collection — reseed in parallel, each contained so one catalog's embed
  // failure does not abort the other or reject the detached caller.
  const catalogs: ReadonlyArray<[label: string, seed: () => Promise<void>]> = [
    [
      "skill",
      async () => {
        const { seedV2SkillEntries } = await import("./skill-store.js");
        await seedV2SkillEntries({ throwOnError: true });
      },
    ],
    [
      "CLI-command",
      async () => {
        const { seedV2CliCommandEntries } =
          await import("./cli-command-store.js");
        await seedV2CliCommandEntries({ throwOnError: true });
      },
    ],
  ];

  // Each reseed is contained so one catalog's embed failure (or hang) never
  // rejects the caller or aborts the other. Started here but not awaited as a
  // single barrier — the bounded wait below decides when to stop waiting.
  const reseeds = catalogs.map(([label, seed]) =>
    seed().then(
      () =>
        log.info(
          `Memory v2 ${label} entries seeded after managed proxy credential update`,
        ),
      (err: unknown) =>
        log.warn(
          { err },
          `Failed to seed v2 ${label} entries after managed proxy credential update`,
        ),
    ),
  );

  // When v3 is live, a maintain pass embeds the freshly-seeded capability rows
  // into `memory_v3_sections` and invalidates the lanes so v3 surfaces the
  // skill/CLI pages within seconds instead of waiting out the 6h backstop.
  // Resolve the gate + enqueuer once and reuse for the post-barrier enqueue and
  // the straggler re-enqueue below.
  const { isMemoryV3Live } =
    await import("../../../../config/memory-v3-gate.js");
  const v3Live = isMemoryV3Live(config);
  const enqueueMaintain = async (): Promise<void> => {
    if (!v3Live) return;
    try {
      const { enqueueMemoryJob } =
        await import("../../../../persistence/jobs-store.js");
      enqueueMemoryJob("memory_v3_maintain", {});
    } catch (err) {
      log.warn(
        { err },
        "Failed to enqueue memory_v3_maintain after managed proxy credential update",
      );
    }
  };

  // Bound the barrier so a wedged catalog can't block the maintain enqueue
  // indefinitely; the reseeds keep running detached past the timeout.
  const timeoutMs = opts.reseedTimeoutMs ?? RESEED_BARRIER_TIMEOUT_MS;
  const allReseeds = Promise.allSettled(reseeds);
  const settledInTime = await settledWithin(allReseeds, timeoutMs);

  await enqueueMaintain();

  if (!settledInTime) {
    log.warn(
      { timeoutMs },
      "Capability reseed still running after the barrier timeout — enqueued v3 maintain now; will re-enqueue when the straggler catalog finishes",
    );
    // The straggler is still embedding; re-enqueue maintain once it lands so its
    // late capability rows are reconciled without waiting out the 6h backstop.
    void allReseeds.then(() => enqueueMaintain());
  }
}

/**
 * Build the v2 BM25 corpus stats (per-token document frequencies + avg doc
 * length), then re-seed the v2 skill entries so any skills written during
 * cold start with the legacy TF encoder get rewritten with stemmed BM25
 * vectors. The cold-start window exists because the very first
 * `maybeSeedMemoryV2Skills` call can race ahead of the corpus-stats build —
 * `skill-store.runSeedOnce` falls back to `generateSparseEmbedding` while
 * `getConceptPageCorpusStats()` is still `null`, leaving stored skill
 * sparse vectors in a different hash space than the BM25 query vectors
 * callers issue (see `simBatch`, `activation.selectCandidates`). Reseeding
 * here closes that gap without operator intervention.
 *
 * Fire-and-forget by design — startup must not block on either step. The
 * reseed depends on the corpus-stats build, so a corpus-stats failure
 * short-circuits and skips the reseed (the BM25 vectors it would produce
 * would be wrong without fresh stats). Both steps log and swallow their own
 * errors so neither blocks startup.
 */
export async function rebuildBm25CorpusStatsAndReseedSkills(
  config: AssistantConfig,
): Promise<void> {
  if (!config.memory.v2.enabled) return;

  try {
    const { rebuildConceptPageCorpusStats } = await import("./sparse-bm25.js");
    await rebuildConceptPageCorpusStats(getWorkspaceDir());
    log.info("Memory v2 BM25 corpus stats built");
  } catch (err) {
    log.warn(
      { err },
      "BM25 corpus-stats rebuild failed — sparse channel will fall back to TF-only until next rebuild",
    );
    return;
  }

  // Skills and CLI commands share the unified collection but are independent
  // catalogs — reseed in parallel so the second one isn't gated on the first.
  await Promise.all([
    (async () => {
      try {
        const { seedV2SkillEntries } = await import("./skill-store.js");
        await seedV2SkillEntries({ throwOnError: true });
        log.info(
          "Memory v2 skill embeddings re-seeded with BM25 vectors after corpus-stats build",
        );
      } catch (err) {
        log.warn(
          { err },
          "Failed to re-seed v2 skill entries after BM25 corpus-stats build — skills seeded during cold start may keep TF-only sparse vectors until next reseed",
        );
      }
    })(),
    (async () => {
      try {
        const { seedV2CliCommandEntries } =
          await import("./cli-command-store.js");
        await seedV2CliCommandEntries({ throwOnError: true });
        log.info(
          "Memory v2 CLI-command embeddings re-seeded with BM25 vectors after corpus-stats build",
        );
      } catch (err) {
        log.warn(
          { err },
          "Failed to re-seed v2 CLI-command entries after BM25 corpus-stats build — entries seeded during cold start may keep TF-only sparse vectors until next reseed",
        );
      }
    })(),
  ]);
}

/**
 * Reconcile the v2 concept-page Qdrant collection with the expected schema
 * and enqueue `memory_v2_reembed` when the collection is missing data.
 * Triggers reembed in two cases:
 *  - Drift: `ensureConceptPageCollection` returned `{ migrated: true }`
 *    after destructively recreating the collection (e.g. pre-#29823
 *    schemas lacking `summary_*` named vectors).
 *  - Empty-after-create: the collection has zero points but pages exist on
 *    disk — covers crash-mid-rebuild and external Qdrant wipes.
 *
 * Awaited inline by `lifecycle.ts` so the enqueue happens before the memory
 * worker drains its first batch; the body is wrapped in try/catch so a v2
 * failure never blocks startup.
 */
export async function maybeRebuildMemoryV2Concepts(
  config: AssistantConfig,
): Promise<void> {
  if (!config.memory.v2.enabled) return;

  try {
    const {
      ensureConceptPageCollection,
      countConceptPagePoints,
      clearReembedSentinel,
    } = await import("./qdrant.js");
    const { hasConceptPages } = await import("./page-store.js");
    const { enqueueMemoryJob, hasActiveJobOfType } =
      await import("../../../../persistence/jobs-store.js");

    const { migrated } = await ensureConceptPageCollection();

    let shouldReembed = migrated;
    if (!shouldReembed) {
      const points = await countConceptPagePoints();
      if (points === 0 && (await hasConceptPages(getWorkspaceDir()))) {
        shouldReembed = true;
      }
    }

    if (shouldReembed) {
      // The lifecycle startup path runs `reconcileEmbeddingIdentity` immediately
      // before this, and on a commit-fresh/migrate action that reconcile already
      // enqueues `memory_v2_reembed`. Dedup against the in-flight job so the
      // reconcile-then-rebuild interleaving re-embeds the corpus once, not twice.
      if (hasActiveJobOfType("memory_v2_reembed")) {
        log.info(
          "Memory v2 reembed already queued — skipping duplicate enqueue",
        );
        await clearReembedSentinel();
        return;
      }
      const jobId = enqueueMemoryJob("memory_v2_reembed", {});
      log.info(
        { jobId, collectionMigrated: migrated },
        "Memory v2 collection rebuild required — enqueued reembed job",
      );
      // Clear the on-disk sentinel that the qdrant ensure-path writes before
      // delete: now that reembed is queued, the cross-call signal can retire.
      // If the sentinel never existed this is a no-op.
      await clearReembedSentinel();
    }
  } catch (err) {
    log.warn(
      { err },
      "Memory v2 collection schema check failed — continuing startup; v2 retrieval may be degraded",
    );
  }
}
