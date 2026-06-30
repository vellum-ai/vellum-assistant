/**
 * Tests for `maybeReseedCapabilitiesAfterManagedCredential` in
 * `memory-v2-startup.ts`.
 *
 * The secrets route calls this when a managed-proxy credential lands, to close
 * the first-boot race where the daemon's startup capability seed (skills + CLI
 * commands) runs before the platform provisions the managed embedding
 * credential — the seed's embed throws and the synthetic capability pages never
 * reach the page index. The reseed must fire only when v2 memory is enabled AND
 * the managed-proxy prerequisites are now satisfied, so self-hosted / BYOK
 * assistants (no managed proxy) are never made to run a doomed embed. When v3 is
 * live it then enqueues a `memory_v3_maintain` job so v3 picks up the capability
 * pages immediately instead of waiting out the 6h maintain backstop.
 *
 * Dynamic-imported collaborators are mocked at module scope; `bun:test`
 * isolates `mock.module` per test file.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../../../__tests__/helpers/mock-logger.js";
import type { AssistantConfig } from "../../../../config/schema.js";

const proxyState = { prereqs: true };
const v3State = { live: true };
const seedSkill = mock(async () => {});
const seedCli = mock(async () => {});
const enqueueJob = mock(
  (_type: string, _payload: Record<string, unknown>) => 1,
);

mock.module("../../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

mock.module("../../../../providers/platform-proxy/context.js", () => ({
  hasManagedProxyPrereqs: async () => proxyState.prereqs,
}));

mock.module("../../../../config/memory-v3-gate.js", () => ({
  isMemoryV3Live: () => v3State.live,
}));

mock.module("../../../../persistence/jobs-store.js", () => ({
  enqueueMemoryJob: enqueueJob,
}));

mock.module("./skill-store.js", () => ({
  seedV2SkillEntries: seedSkill,
}));

mock.module("./cli-command-store.js", () => ({
  seedV2CliCommandEntries: seedCli,
}));

const { maybeReseedCapabilitiesAfterManagedCredential } =
  await import("./memory-v2-startup.js");

function configWithV2(enabled: boolean): AssistantConfig {
  return { memory: { v2: { enabled } } } as unknown as AssistantConfig;
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
  v3State.live = true;
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
    v3State.live = true;

    await maybeReseedCapabilitiesAfterManagedCredential(configWithV2(true));

    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(enqueueJob).toHaveBeenCalledWith("memory_v3_maintain", {});
  });

  test("reseeds but does not enqueue a v3 maintain pass when v3 is not live", async () => {
    proxyState.prereqs = true;
    v3State.live = false;

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
    v3State.live = true;
    seedSkill.mockImplementationOnce(async () => {
      throw new Error('Embedding backend "gemini" is not configured');
    });

    await maybeReseedCapabilitiesAfterManagedCredential(configWithV2(true));

    // The CLI catalog seeded, so v3 must still rebuild its lanes — a single
    // catalog failure cannot suppress the maintain pass.
    expect(seedCli).toHaveBeenCalledTimes(1);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(enqueueJob).toHaveBeenCalledWith("memory_v3_maintain", {});
  });

  test("enqueues the v3 maintain pass without blocking when a catalog reseed exceeds the timeout", async () => {
    proxyState.prereqs = true;
    v3State.live = true;
    // Skill reseed never settles — mirrors the wedged getCatalog()/embed seen in
    // the field. The CLI reseed completes normally.
    seedSkill.mockImplementationOnce(() => new Promise<void>(() => {}));

    await maybeReseedCapabilitiesAfterManagedCredential(configWithV2(true), {
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
    v3State.live = true;
    let resolveSkill!: () => void;
    seedSkill.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSkill = resolve;
        }),
    );

    await maybeReseedCapabilitiesAfterManagedCredential(configWithV2(true), {
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
