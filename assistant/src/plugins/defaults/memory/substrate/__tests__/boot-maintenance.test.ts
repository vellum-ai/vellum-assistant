/**
 * Tests for the boot-maintenance helpers in `boot-maintenance.ts`:
 *
 * - `maybeReseedCapabilitiesAfterManagedCredential`: the secrets route calls
 *   this when a managed-proxy credential lands, to close the first-boot race
 *   where the daemon's startup capability seed (skills + CLI commands) runs
 *   before the platform provisions the managed embedding credential — the
 *   seed's embed throws and the synthetic capability pages never reach the
 *   page index. The reseed must fire only when the substrate is active AND the
 *   managed-proxy prerequisites are now satisfied, so self-hosted / BYOK
 *   assistants (no managed proxy) are never made to run a doomed embed. When
 *   v3 is live it then enqueues a `memory_v3_maintain` job so v3 picks up the
 *   capability pages immediately instead of waiting out the 6h maintain
 *   backstop.
 *
 * - `maybeRebuildConceptCollection`: reembed-enqueue dedup against an
 *   in-flight `memory_v2_reembed` job.
 *
 * Dynamic-imported collaborators are mocked; `bun:test` isolates
 * `mock.module` per test file. Every collaborator mock is installed at module
 * scope, BEFORE the first import of the module under test, behind swappable
 * delegate objects; tests retarget delegates instead of calling `mock.module`
 * mid-file. This ordering is load-bearing: `mock.module` on a module that has
 * already been evaluated is not reliably re-linked for a subsequent dynamic
 * import across bun versions (CI's bun served the real, cached
 * `qdrant.js` — pulled in via the real `embedding-reconcile.js` import graph —
 * to the first rebuild test even after `mock.module` ran). Module-scope
 * registration means the real collaborators never load at all.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../../../../../config/schema.js";

const proxyState = { prereqs: true };
const seedSkill = mock(async () => {});
const seedCli = mock(async () => {});
const enqueueJob = mock(
  (_type: string, _payload: Record<string, unknown>) => 1,
);

/**
 * Swappable delegates behind the module-scope mocks. A module namespace's
 * export set is fixed at instantiation, so every export is declared up front
 * and `withMocks` retargets the delegates instead of re-installing a mock.
 */
const jobsStoreDelegates: {
  enqueueMemoryJob: (type: string, payload: Record<string, unknown>) => unknown;
  hasActiveJobOfType: (type: string) => boolean;
} = {
  enqueueMemoryJob: enqueueJob,
  hasActiveJobOfType: () => false,
};

const qdrantDelegates: {
  ensureConceptPageCollection: () => Promise<{ migrated: boolean }>;
  countConceptPagePoints: () => Promise<number>;
  clearReembedSentinel: () => Promise<void>;
} = {
  ensureConceptPageCollection: async () => ({ migrated: false }),
  countConceptPagePoints: async () => 0,
  clearReembedSentinel: async () => {},
};

const pageStoreDelegates: {
  hasConceptPages: (workspaceDir: string) => Promise<boolean>;
} = {
  hasConceptPages: async () => true,
};

mock.module("../../../../../providers/platform-proxy/context.js", () => ({
  hasManagedProxyPrereqs: async () => proxyState.prereqs,
}));

// `config/memory-v3-gate.js` is deliberately NOT mocked. It is pure (its only
// import is a type) and it is the predicate under test as much as
// `boot-maintenance.ts` is: the tiers are selected by real config here, so a
// semantics change in `usesConceptPageMemory` / `isMemoryV3Live` fails these
// tests instead of passing against a hand-inlined copy.

mock.module("../../../../../persistence/jobs-store.js", () => ({
  enqueueMemoryJob: (type: string, payload: Record<string, unknown>) =>
    jobsStoreDelegates.enqueueMemoryJob(type, payload),
  hasActiveJobOfType: (type: string) =>
    jobsStoreDelegates.hasActiveJobOfType(type),
}));

mock.module("../skill-store.js", () => ({
  seedV2SkillEntries: seedSkill,
}));

mock.module("../cli-command-store.js", () => ({
  seedV2CliCommandEntries: seedCli,
}));

mock.module("../qdrant.js", () => ({
  ensureConceptPageCollection: () =>
    qdrantDelegates.ensureConceptPageCollection(),
  countConceptPagePoints: () => qdrantDelegates.countConceptPagePoints(),
  clearReembedSentinel: () => qdrantDelegates.clearReembedSentinel(),
  dropLegacySkillsCollection: async () => {},
}));

mock.module("../page-store.js", () => ({
  hasConceptPages: (workspaceDir: string) =>
    pageStoreDelegates.hasConceptPages(workspaceDir),
}));

// The real embedding-reconcile statically imports the real `../qdrant.js`
// (among a large daemon graph); mocking it keeps that graph out of the module
// cache entirely. No test here asserts on the reconcile itself — the reseed
// path contains its failures by contract.
mock.module("../../../../../daemon/embedding-reconcile.js", () => ({
  reconcileEmbeddingIdentity: async () => {},
}));

const {
  maybeRebuildConceptCollection,
  maybeReseedCapabilitiesAfterManagedCredential,
} = await import("../boot-maintenance.js");

/**
 * Substrate active (or not) via the v2 injection engine, with v3 NOT live:
 * `usesConceptPageMemory` follows `enabled`, `isMemoryV3Live` is false.
 */
function configWithV2(enabled: boolean): AssistantConfig {
  return { memory: { v2: { enabled } } } as unknown as AssistantConfig;
}

/**
 * Substrate active with memory-v3 as the live injected source — the shape a
 * v3-live assistant actually carries (`v2.enabled` stays set alongside
 * `v3.live`).
 */
function configWithV3(): AssistantConfig {
  return {
    memory: { v2: { enabled: true }, v3: { live: true } },
  } as unknown as AssistantConfig;
}

/** Poll until `m` has been called at least `n` times, or `timeoutMs` elapses. */
async function waitForCalls(
  m: { mock: { calls: unknown[] } },
  n: number,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (m.mock.calls.length < n && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  seedSkill.mockClear();
  seedCli.mockClear();
  enqueueJob.mockClear();
  proxyState.prereqs = true;
});

describe("maybeReseedCapabilitiesAfterManagedCredential", () => {
  test("reseeds both skill and CLI entries when v2 is enabled and managed-proxy prereqs are satisfied", async () => {
    proxyState.prereqs = true;

    await maybeReseedCapabilitiesAfterManagedCredential(configWithV2(true));

    expect(seedSkill).toHaveBeenCalledTimes(1);
    expect(seedCli).toHaveBeenCalledTimes(1);
  });

  test("enqueues a v3 maintain pass after reseeding when v3 is live", async () => {
    proxyState.prereqs = true;

    await maybeReseedCapabilitiesAfterManagedCredential(configWithV3());

    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(enqueueJob).toHaveBeenCalledWith("memory_v3_maintain", {});
  });

  test("reseeds but does not enqueue a v3 maintain pass when v3 is not live", async () => {
    proxyState.prereqs = true;

    await maybeReseedCapabilitiesAfterManagedCredential(configWithV2(true));

    expect(seedSkill).toHaveBeenCalledTimes(1);
    expect(seedCli).toHaveBeenCalledTimes(1);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  test("no-op when v2 memory is disabled", async () => {
    await maybeReseedCapabilitiesAfterManagedCredential(configWithV2(false));

    expect(seedSkill).not.toHaveBeenCalled();
    expect(seedCli).not.toHaveBeenCalled();
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  test("no-op for non-managed assistants (managed-proxy prereqs not satisfied)", async () => {
    proxyState.prereqs = false;

    await maybeReseedCapabilitiesAfterManagedCredential(configWithV2(true));

    expect(seedSkill).not.toHaveBeenCalled();
    expect(seedCli).not.toHaveBeenCalled();
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  test("swallows a seed failure and still reseeds the other catalog", async () => {
    proxyState.prereqs = true;
    seedSkill.mockImplementationOnce(async () => {
      throw new Error('Embedding backend "gemini" is not configured');
    });

    // Must not reject — the helper contains each seed's failure so a doomed
    // embed never propagates back to the credential-store caller.
    await maybeReseedCapabilitiesAfterManagedCredential(configWithV2(true));

    expect(seedCli).toHaveBeenCalledTimes(1);
  });

  test("enqueues the v3 maintain pass even when one catalog reseed rejects", async () => {
    proxyState.prereqs = true;
    seedSkill.mockImplementationOnce(async () => {
      throw new Error('Embedding backend "gemini" is not configured');
    });

    await maybeReseedCapabilitiesAfterManagedCredential(configWithV3());

    // The CLI catalog seeded, so v3 must still rebuild its lanes — a single
    // catalog failure cannot suppress the maintain pass.
    expect(seedCli).toHaveBeenCalledTimes(1);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(enqueueJob).toHaveBeenCalledWith("memory_v3_maintain", {});
  });

  test("enqueues the v3 maintain pass without blocking when a catalog reseed exceeds the timeout", async () => {
    proxyState.prereqs = true;
    // Skill reseed never settles — mirrors the wedged getCatalog()/embed seen in
    // the field. The CLI reseed completes normally.
    seedSkill.mockImplementationOnce(() => new Promise<void>(() => {}));

    await maybeReseedCapabilitiesAfterManagedCredential(configWithV3(), {
      reseedTimeoutMs: 20,
    });

    // An unbounded `Promise.all` barrier would hang here forever; the bounded
    // barrier lets the CLI catalog's maintain pass enqueue regardless.
    expect(seedCli).toHaveBeenCalledTimes(1);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(enqueueJob).toHaveBeenCalledWith("memory_v3_maintain", {});
  });

  test("re-enqueues the v3 maintain pass when a straggler catalog finishes after the timeout", async () => {
    proxyState.prereqs = true;
    let resolveSkill!: () => void;
    seedSkill.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSkill = resolve;
        }),
    );

    await maybeReseedCapabilitiesAfterManagedCredential(configWithV3(), {
      reseedTimeoutMs: 10,
    });

    // Post-barrier enqueue fires once even though the skill catalog is still
    // embedding.
    expect(enqueueJob).toHaveBeenCalledTimes(1);

    // The straggler lands; maintain re-enqueues so its late capability rows are
    // reconciled without waiting out the 6h backstop.
    resolveSkill();
    await waitForCalls(enqueueJob, 2);
    expect(enqueueJob).toHaveBeenCalledTimes(2);
  });
});

/**
 * Retarget the module-scope delegates at fresh spies for one
 * `maybeRebuildConceptCollection` test and return them.
 *
 * Drives the empty-after-create branch (collection not migrated, zero points,
 * pages on disk) so the reembed enqueue decision is reached, and lets the test
 * choose whether a `memory_v2_reembed` job is already in-flight.
 * `hasConceptPages` ignores its workspace-dir argument, so the real
 * `getWorkspaceDir()` (resolving to the preload's per-test temp workspace)
 * needs no mock.
 */
function withMocks(opts: { reembedInFlight: boolean }) {
  const spies = {
    enqueueMemoryJob: mock(() => "job-id"),
    hasActiveJobOfType: mock(
      (type: string) => opts.reembedInFlight && type === "memory_v2_reembed",
    ),
    ensureConceptPageCollection: mock(async () => ({ migrated: false })),
    countConceptPagePoints: mock(async () => 0),
    clearReembedSentinel: mock(async () => {}),
    hasConceptPages: mock(async () => true),
  };

  jobsStoreDelegates.enqueueMemoryJob = spies.enqueueMemoryJob;
  jobsStoreDelegates.hasActiveJobOfType = spies.hasActiveJobOfType;
  qdrantDelegates.ensureConceptPageCollection =
    spies.ensureConceptPageCollection;
  qdrantDelegates.countConceptPagePoints = spies.countConceptPagePoints;
  qdrantDelegates.clearReembedSentinel = spies.clearReembedSentinel;
  pageStoreDelegates.hasConceptPages = spies.hasConceptPages;

  return spies;
}

describe("maybeRebuildConceptCollection reembed dedup", () => {
  test("does NOT enqueue a second reembed when one is already in-flight", async () => {
    const spies = withMocks({ reembedInFlight: true });

    await maybeRebuildConceptCollection(configWithV2(true));

    expect(spies.hasActiveJobOfType).toHaveBeenCalledWith("memory_v2_reembed");
    expect(spies.enqueueMemoryJob).toHaveBeenCalledTimes(0);
    // The sentinel is still retired even when the enqueue is skipped.
    expect(spies.clearReembedSentinel).toHaveBeenCalledTimes(1);
  });

  test("enqueues the reembed when none is in-flight", async () => {
    const spies = withMocks({ reembedInFlight: false });

    await maybeRebuildConceptCollection(configWithV2(true));

    expect(spies.enqueueMemoryJob).toHaveBeenCalledTimes(1);
    expect(spies.enqueueMemoryJob).toHaveBeenCalledWith(
      "memory_v2_reembed",
      {},
    );
    expect(spies.clearReembedSentinel).toHaveBeenCalledTimes(1);
  });
});
