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
 * assistants (no managed proxy) are never made to run a doomed embed.
 *
 * Dynamic-imported collaborators are mocked at module scope; `bun:test`
 * isolates `mock.module` per test file.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../__tests__/helpers/mock-logger.js";
import type { AssistantConfig } from "../config/schema.js";

const proxyState = { prereqs: true };
const seedSkill = mock(async () => {});
const seedCli = mock(async () => {});

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

mock.module("../providers/platform-proxy/context.js", () => ({
  hasManagedProxyPrereqs: async () => proxyState.prereqs,
}));

mock.module("../memory/v2/skill-store.js", () => ({
  seedV2SkillEntries: seedSkill,
}));

mock.module("../memory/v2/cli-command-store.js", () => ({
  seedV2CliCommandEntries: seedCli,
}));

const { maybeReseedCapabilitiesAfterManagedCredential } =
  await import("./memory-v2-startup.js");

function configWithV2(enabled: boolean): AssistantConfig {
  return { memory: { v2: { enabled } } } as unknown as AssistantConfig;
}

afterEach(() => {
  seedSkill.mockClear();
  seedCli.mockClear();
  proxyState.prereqs = true;
});

describe("maybeReseedCapabilitiesAfterManagedCredential", () => {
  test("reseeds both skill and CLI entries when v2 is enabled and managed-proxy prereqs are satisfied", async () => {
    proxyState.prereqs = true;

    await maybeReseedCapabilitiesAfterManagedCredential(configWithV2(true));

    expect(seedSkill).toHaveBeenCalledTimes(1);
    expect(seedCli).toHaveBeenCalledTimes(1);
  });

  test("no-op when v2 memory is disabled", async () => {
    await maybeReseedCapabilitiesAfterManagedCredential(configWithV2(false));

    expect(seedSkill).not.toHaveBeenCalled();
    expect(seedCli).not.toHaveBeenCalled();
  });

  test("no-op for non-managed assistants (managed-proxy prereqs not satisfied)", async () => {
    proxyState.prereqs = false;

    await maybeReseedCapabilitiesAfterManagedCredential(configWithV2(true));

    expect(seedSkill).not.toHaveBeenCalled();
    expect(seedCli).not.toHaveBeenCalled();
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
});
