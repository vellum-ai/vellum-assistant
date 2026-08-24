/**
 * Tests for `prepareAgentEnv`, the shared helper that injects required env
 * vars onto an `AcpAgentConfig` and preflights that they're set.
 *
 * The route-level test in `runtime/routes/acp-routes.test.ts` covers the same
 * behavior through the HTTP handler; these tests pin the helper in isolation
 * so the contract is clear and a future refactor can't silently break it.
 *
 * Credential reads go through the credential broker (`serverUse`), which is
 * exercised for real here: the metadata store and the encrypted secure-key
 * store are pointed at a temp dir, so the tool and domain policy these tests
 * observe is the same policy production evaluates.
 *
 * The module logger is the one exception. `mock.module` does not hoist above
 * static imports, so the module under test is imported dynamically AFTER the
 * mock is installed: that makes `prepare-agent-env.js` the only module holding
 * the spy logger, so every warn the spy records came from `prepareAgentEnv`.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { setStorePathForTesting } from "../../__tests__/encrypted-store-test-helpers.js";
import { createMockLoggerModule } from "../../__tests__/helpers/mock-logger.js";
import { FailedDependencyError } from "../../runtime/routes/errors.js";
import { credentialKey } from "../../security/credential-key.js";
import {
  _resetBackend,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import { credentialBroker } from "../../tools/credentials/broker.js";
import {
  _setMetadataPath,
  deleteCredentialMetadata,
  getCredentialMetadata,
  upsertCredentialMetadata,
} from "../../tools/credentials/metadata-store.js";
import { ACP_OAUTH_TOKEN_FIELD, ACP_SERVICE } from "../acp-credentials.js";

const mockLogWarn = mock((_fields: unknown, _msg: string) => {});

mock.module("../../util/logger.js", () =>
  createMockLoggerModule({
    getLogger: () => ({
      warn: mockLogWarn,
      info: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
    }),
  }),
);

const {
  ACP_CLAUDE_OAUTH_MISSING_CODE,
  acpSpawnCredentialDenialReason,
  ensureAcpCredentialPolicy,
  prepareAgentEnv,
  repairAcpSpawnPolicy,
} = await import("../prepare-agent-env.js");

const ACP_SPAWN_TOOL = "acp_spawn";

const TEST_DIR = join(
  tmpdir(),
  `vellum-prepare-agent-env-test-${randomBytes(4).toString("hex")}`,
);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  setStorePathForTesting(join(TEST_DIR, "keys.enc"));
  _resetBackend();
  _setMetadataPath(join(TEST_DIR, "metadata.json"));
  mockLogWarn.mockClear();
});

afterEach(() => {
  _setMetadataPath(null);
  setStorePathForTesting(null);
  _resetBackend();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers to seed the vault + metadata (simulates `assistant credentials set`).
// ---------------------------------------------------------------------------

async function seedVaultValue(field: string, value: string): Promise<void> {
  await setSecureKeyAsync(credentialKey(ACP_SERVICE, field), value);
}

function seedVaultToken(token: string): Promise<void> {
  return seedVaultValue(ACP_OAUTH_TOKEN_FIELD, token);
}

function oauthMetadata() {
  return getCredentialMetadata(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD);
}

/**
 * Structured fields of the single injection-miss warn the module emitted.
 * Exactly one line per failed spawn: it is the operator's only record of WHY
 * the token was missing, and a duplicate would double-count in log searches.
 */
function soleInjectionMissWarnFields(): Record<string, unknown> {
  expect(mockLogWarn).toHaveBeenCalledTimes(1);
  const [fields, message] = mockLogWarn.mock.calls[0] as [
    Record<string, unknown>,
    string,
  ];
  expect(message).toBe("Claude OAuth token not injected for acp_spawn");
  expect(fields.field).toBe(ACP_OAUTH_TOKEN_FIELD);
  return fields;
}

describe("prepareAgentEnv — claude-agent-acp gating", () => {
  test("injects CLAUDE_CODE_OAUTH_TOKEN from the vault via the broker when agent.env has no override", async () => {
    await seedVaultToken("vault-AAA");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("vault-AAA");
  });

  test("auto-registers metadata with acp_spawn in allowedTools when none exists", async () => {
    await seedVaultToken("vault-auto-meta");

    await prepareAgentEnv({ command: "claude-agent-acp", args: [] });

    expect(oauthMetadata()?.allowedTools).toContain(ACP_SPAWN_TOOL);
  });

  test("adds acp_spawn to metadata with empty allowedTools (default provisioning path)", async () => {
    upsertCredentialMetadata(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD, {
      allowedTools: [],
    });
    await seedVaultToken("vault-augment");

    await prepareAgentEnv({ command: "claude-agent-acp", args: [] });

    expect(oauthMetadata()?.allowedTools).toContain(ACP_SPAWN_TOOL);
  });

  test("respects explicit tool policy that excludes acp_spawn", async () => {
    upsertCredentialMetadata(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD, {
      allowedTools: ["other_tool"],
    });
    await seedVaultToken("vault-restricted");

    await expect(
      prepareAgentEnv({ command: "claude-agent-acp", args: [] }),
    ).rejects.toThrow("CLAUDE_CODE_OAUTH_TOKEN");

    expect(oauthMetadata()?.allowedTools).toEqual(["other_tool"]);
  });

  test("accepts CLAUDE_CODE_OAUTH_TOKEN from agent.env (config.json override) with no vault entry", async () => {
    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
      env: { CLAUDE_CODE_OAUTH_TOKEN: "config-BBB" },
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("config-BBB");
  });

  test("agent.env override wins over the vault entry (precedence pin)", async () => {
    await seedVaultToken("vault-CCC");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
      env: { CLAUDE_CODE_OAUTH_TOKEN: "config-DDD" },
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("config-DDD");
  });

  test("preserves unrelated env vars on agent.env when injecting from the vault", async () => {
    await seedVaultToken("vault-EEE");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
      env: { OTHER_VAR: "keep-me" },
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("vault-EEE");
    expect(prepared.env?.OTHER_VAR).toBe("keep-me");
  });

  test("throws FailedDependencyError when no token is provided from either route", async () => {
    await expect(
      prepareAgentEnv({ command: "claude-agent-acp", args: [] }),
    ).rejects.toThrow("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("enriches the missing-token error with the acp_claude_oauth_missing marker AND directs the model at the inline Connect card", async () => {
    let caught: unknown;
    try {
      await prepareAgentEnv({ command: "claude-agent-acp", args: [] });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FailedDependencyError);
    // Structured marker survives as `details` for the client to branch on.
    expect((caught as FailedDependencyError).details).toEqual({
      code: ACP_CLAUDE_OAUTH_MISSING_CODE,
    });
    const message = (caught as Error).message;
    // Names the missing env var (the token) so the failure is legible.
    expect(message).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    // Directs the model at the inline card, not a CLI/token-paste workaround.
    expect(message).toContain("Connect Claude Code");
    expect(message).toContain("Do NOT");
    expect(message).toContain("claude setup-token");
    // Keeps the headless CLI fallback available, via the secure prompt.
    expect(message).toContain("assistant credentials prompt");
    // Corrects the earlier "nothing to paste" framing — the cloud (manual) flow
    // does paste a key, and the model is told not to claim otherwise.
    expect(message).toContain("does paste a key");
    // Steers the model toward a terse reply, not meta-narration about the card.
    expect(message).toContain("ONE short sentence");
    // Tells the model the task auto-continues after connect (no manual retry).
    expect(message).toContain("continue automatically");
    expect(message).toContain("do NOT retry the spawn yourself");
    // Forbids positional claims about the card — placement is a client-render
    // detail the model can't see, so "below"/"above" are hallucinations. The
    // card actually renders above the model's reply, so "below" is always wrong.
    expect(message).toContain('never say "below"');
    expect(message).toContain('"above"');
    // Pins the seam between the opening and the shared guidance: an absent
    // value keeps the "which is not set" wording verbatim.
    expect(message).toContain(
      'which is not set. The app shows the user an inline "Connect Claude Code" card.',
    );

    // The operator-facing half: the broker's own reason, classified.
    const fields = soleInjectionMissWarnFields();
    expect(fields.missReason).toContain("no stored value");
    expect(fields.policyBlocked).toBe(false);
    expect(fields.apiKeyShaped).toBe(false);
  });

  test("a policy-denied read logs the broker reason and reports the policy block", async () => {
    // Invariant: a policy-denied read must be reported as a policy block, not
    // as an absent value. The two states have different repair stories, and
    // the message must never assert that a value is stored (policy is checked
    // before the value, so metadata alone can trigger this branch).
    upsertCredentialMetadata(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD, {
      allowedTools: ["bash"],
    });
    await seedVaultToken("sk-ant-oat01-policy-blocked");

    let caught: unknown;
    try {
      await prepareAgentEnv({ command: "claude-agent-acp", args: [] });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FailedDependencyError);
    // Same wire contract: old clients keep rendering the same Connect card.
    expect((caught as FailedDependencyError).details).toEqual({
      code: ACP_CLAUDE_OAUTH_MISSING_CODE,
    });
    const message = (caught as Error).message;
    expect(message).toContain("cannot read the Claude OAuth token");
    expect(message).toContain("blocks the acp_spawn read");
    expect(message).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(message).toContain("signs in again and repairs that policy");
    // Policy is checked before the value, so the message must never assert
    // that a value is actually stored.
    expect(message).not.toContain("has a stored");
    expect(message).not.toContain("which is not set");
    // The guidance steering the model away from CLI/token-paste workarounds is
    // shared with the missing-value variant, so it must survive here too.
    expect(message).toContain("ONE short sentence");
    expect(message).toContain("Do NOT");
    expect(message).toContain("claude setup-token");
    expect(message).toContain("do NOT retry the spawn yourself");
    expect(message).toContain("assistant credentials prompt");

    const fields = soleInjectionMissWarnFields();
    expect(fields.missReason).toContain(
      'Tool "acp_spawn" is not allowed to use credential acp/claude_oauth_token',
    );
    expect(fields.policyBlocked).toBe(true);
    expect(fields.apiKeyShaped).toBe(false);
    // The denial reason is a policy verdict, never the credential itself.
    expect(JSON.stringify(fields)).not.toContain("sk-ant-oat01-policy-blocked");
  });

  test("does NOT attach the marker when a token is present (happy path unchanged)", async () => {
    await seedVaultToken("vault-marker-absent");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("vault-marker-absent");
  });

  test("routes a legacy API key in the OAuth field to the repairable missing-token path", async () => {
    // A workspace that stored an `sk-ant-api…` key here before the write-path
    // format guard existed must not spawn with a doomed credential (a 401 with
    // no repair). The presence check alone would pass, so the injected value is
    // classified and an API key is treated as missing → the Connect card fires.
    await seedVaultToken("sk-ant-api03-legacy-bad-value");

    let caught: unknown;
    try {
      await prepareAgentEnv({ command: "claude-agent-acp", args: [] });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FailedDependencyError);
    expect((caught as FailedDependencyError).details).toEqual({
      code: ACP_CLAUDE_OAUTH_MISSING_CODE,
    });
    // Connect genuinely repairs this by storing a fresh OAuth token, so the
    // message stays the missing-token one rather than the policy-blocked one.
    expect((caught as Error).message).toContain(
      'which is not set. The app shows the user an inline "Connect Claude Code" card.',
    );

    // The log is where the api-key shape is recorded; the value never is.
    const fields = soleInjectionMissWarnFields();
    expect(fields.apiKeyShaped).toBe(true);
    expect(fields.policyBlocked).toBe(false);
    expect(fields.missReason).toBeUndefined();
    expect(JSON.stringify(fields)).not.toContain(
      "sk-ant-api03-legacy-bad-value",
    );
  });

  test("routes an API key supplied via agent.env (config override) to the missing-token path", async () => {
    // The override wins over the vault, so an API key here would otherwise be
    // spawned as an OAuth token. It must be classified and repaired the same way.
    let caught: unknown;
    try {
      await prepareAgentEnv({
        command: "claude-agent-acp",
        args: [],
        env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-api03-override-bad" },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FailedDependencyError);
    expect((caught as FailedDependencyError).details).toEqual({
      code: ACP_CLAUDE_OAUTH_MISSING_CODE,
    });
  });

  test("a stale API-key config override does NOT shadow a valid vault OAuth token (auto-continue recovers)", async () => {
    // The loop bug: after the user connects (OAuth token stored in the vault), a
    // re-spawn still carries the legacy `sk-ant-api…` value in config `env`. If
    // that override skipped the vault read, the freshly-stored token would never
    // be used and the Connect card would re-fire forever. The bad override is
    // dropped BEFORE the read, so the vault OAuth token is picked up and spawn
    // proceeds instead of looping.
    await seedVaultToken("sk-ant-oat01-freshly-connected");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-api03-stale-override" },
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "sk-ant-oat01-freshly-connected",
    );
  });

  test("keeps a valid OAuth token (sk-ant-oat…) usable (not misclassified)", async () => {
    await seedVaultToken("sk-ant-oat01-good-token");

    const prepared = await prepareAgentEnv({
      command: "claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "sk-ant-oat01-good-token",
    );
  });

  test("gates on the resolved command BASENAME (alias to /custom/path/claude-agent-acp still gets the token)", async () => {
    await seedVaultToken("vault-FFF");

    const prepared = await prepareAgentEnv({
      command: "/opt/bin/claude-agent-acp",
      args: [],
    });

    expect(prepared.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("vault-FFF");
  });

  test("does NOT mutate the caller's agentConfig", async () => {
    await seedVaultToken("vault-GGG");
    const original = {
      command: "claude-agent-acp",
      args: [],
      env: { OTHER: "keep" },
    };
    const beforeEnv = { ...original.env };

    const prepared = await prepareAgentEnv(original);

    expect(prepared).not.toBe(original);
    expect(prepared.env).not.toBe(original.env);
    expect(original.env).toEqual(beforeEnv);
    expect(original.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });
});

describe("prepareAgentEnv - codex-acp gating", () => {
  function seedVaultOpenaiKey(key: string): Promise<void> {
    return seedVaultValue("openai_api_key", key);
  }

  function seedVaultCodexKey(key: string): Promise<void> {
    return seedVaultValue("codex_api_key", key);
  }

  test("injects OPENAI_API_KEY from the vault via the broker when agent.env has no override", async () => {
    await seedVaultOpenaiKey("vault-fake-openai-AAA");

    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
    });

    expect(prepared.env?.OPENAI_API_KEY).toBe("vault-fake-openai-AAA");
  });

  test("agent.env override wins over the vault entry and skips the broker (precedence pin)", async () => {
    // Seed a vault value but no metadata: if the override path consulted the
    // broker anyway, ensureAcpCredentialPolicy would create metadata here.
    await seedVaultOpenaiKey("vault-fake-openai-BBB");

    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
      env: { OPENAI_API_KEY: "config-fake-openai-CCC" },
    });

    expect(prepared.env?.OPENAI_API_KEY).toBe("config-fake-openai-CCC");
    expect(
      getCredentialMetadata(ACP_SERVICE, "openai_api_key"),
    ).toBeUndefined();
  });

  test("a vault miss for both fields does NOT throw and spawns with env unchanged (keys are optional)", async () => {
    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
      env: { NO_COLOR: "1" },
    });

    expect(prepared.env).toEqual({ NO_COLOR: "1" });
    expect(prepared.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(prepared.env).not.toHaveProperty("CODEX_API_KEY");
  });

  test("injects CODEX_API_KEY independently of OPENAI_API_KEY", async () => {
    await seedVaultCodexKey("vault-fake-codex-DDD");

    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
    });

    expect(prepared.env?.CODEX_API_KEY).toBe("vault-fake-codex-DDD");
    expect(prepared.env).not.toHaveProperty("OPENAI_API_KEY");
  });

  test("injects both keys when both vault fields are present", async () => {
    await seedVaultOpenaiKey("vault-fake-openai-EEE");
    await seedVaultCodexKey("vault-fake-codex-FFF");

    const prepared = await prepareAgentEnv({
      command: "codex-acp",
      args: [],
    });

    expect(prepared.env?.OPENAI_API_KEY).toBe("vault-fake-openai-EEE");
    expect(prepared.env?.CODEX_API_KEY).toBe("vault-fake-codex-FFF");
  });

  test("gates on the resolved command BASENAME (custom agent id with full path still gets injection)", async () => {
    await seedVaultOpenaiKey("vault-fake-openai-GGG");

    const prepared = await prepareAgentEnv({
      command: "/data/.bun/bin/codex-acp",
      args: [],
    });

    expect(prepared.env?.OPENAI_API_KEY).toBe("vault-fake-openai-GGG");
  });
});

describe("prepareAgentEnv — non-claude commands", () => {
  test("returns the config unchanged for an unrecognized command basename", async () => {
    await seedVaultToken("vault-HHH");

    const prepared = await prepareAgentEnv({
      command: "some-future-adapter",
      args: [],
      env: { FOO: "bar" },
    });

    expect(prepared.env).toEqual({ FOO: "bar" });
  });
});

/**
 * The Connect flow's repair, which `storeAcpClaudeToken` performs after writing
 * the token. Every metadata shape the broker can deny on is covered here, so
 * `acp-claude-oauth.test.ts` only has to pin the end-to-end wiring.
 */
describe("repairAcpSpawnPolicy - the Connect repair", () => {
  test("creates a record with acp_spawn, the usage description, and no domain restriction when none exists", () => {
    repairAcpSpawnPolicy(ACP_OAUTH_TOKEN_FIELD, "desc");

    expect(oauthMetadata()?.allowedTools).toEqual([ACP_SPAWN_TOOL]);
    expect(oauthMetadata()?.allowedDomains).toEqual([]);
    expect(oauthMetadata()?.usageDescription).toBe("desc");
  });

  test("adds acp_spawn to an empty allowedTools (default provisioning path)", () => {
    upsertCredentialMetadata(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD, {
      allowedTools: [],
    });

    repairAcpSpawnPolicy(ACP_OAUTH_TOKEN_FIELD, "desc");

    expect(oauthMetadata()?.allowedTools).toEqual([ACP_SPAWN_TOOL]);
  });

  test("unions acp_spawn into an explicit policy that omitted it", () => {
    upsertCredentialMetadata(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD, {
      allowedTools: ["other_tool"],
    });

    repairAcpSpawnPolicy(ACP_OAUTH_TOKEN_FIELD, "desc");

    // Unlike ensureAcpCredentialPolicy (which preserves), the repair widens.
    expect(oauthMetadata()?.allowedTools).toEqual([
      "other_tool",
      ACP_SPAWN_TOOL,
    ]);
  });

  test("clears a domain restriction the broker refuses server-side, keeping the tools", () => {
    upsertCredentialMetadata(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD, {
      allowedTools: [ACP_SPAWN_TOOL],
      allowedDomains: ["api.anthropic.com"],
    });

    repairAcpSpawnPolicy(ACP_OAUTH_TOKEN_FIELD, "desc");

    expect(oauthMetadata()?.allowedDomains).toEqual([]);
    expect(oauthMetadata()?.allowedTools).toEqual([ACP_SPAWN_TOOL]);
  });

  test("repairs both halves of a denied policy in one pass", () => {
    upsertCredentialMetadata(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD, {
      allowedTools: ["other_tool"],
      allowedDomains: ["api.anthropic.com"],
    });

    repairAcpSpawnPolicy(ACP_OAUTH_TOKEN_FIELD, "desc");

    expect(oauthMetadata()?.allowedTools).toEqual([
      "other_tool",
      ACP_SPAWN_TOOL,
    ]);
    expect(oauthMetadata()?.allowedDomains).toEqual([]);
  });

  test("writes nothing when the stored policy already satisfies both halves", async () => {
    upsertCredentialMetadata(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD, {
      allowedTools: [ACP_SPAWN_TOOL, "other_tool"],
    });
    const before = oauthMetadata();
    // Every upsert stamps `updatedAt` with the current millisecond, so waiting
    // here makes an unconditional write show up as a changed record.
    await Bun.sleep(5);

    repairAcpSpawnPolicy(ACP_OAUTH_TOKEN_FIELD, "desc");

    expect(oauthMetadata()).toEqual(before);
  });
});

/**
 * Drift guard for the Connect Claude status predicate.
 *
 * `acpSpawnCredentialDenialReason` answers "would the spawn's broker read of
 * this credential succeed?" without performing it, because the status route is
 * a side-effect-free GET. Every state below is run twice: once through the
 * predicate, and once through the real spawn sequence
 * (`ensureAcpCredentialPolicy` then `credentialBroker.serverUse`). The two must
 * agree down to the denial string; this suite fails whenever they diverge.
 *
 * The predicate reads only the persisted value via `getSecureKeyAsync` and
 * never calls `serverUse`, so it can never consume a one-time transient
 * credential the way a real broker read would.
 */
describe("acpSpawnCredentialDenialReason parity with the real spawn read", () => {
  const STATES: { name: string; seed: () => void }[] = [
    { name: "no metadata at all", seed: () => {} },
    {
      name: "empty allowedTools",
      seed: () => {
        upsertCredentialMetadata(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD, {
          allowedTools: [],
        });
      },
    },
    {
      name: "allowedTools listing acp_spawn",
      seed: () => {
        upsertCredentialMetadata(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD, {
          allowedTools: [ACP_SPAWN_TOOL],
        });
      },
    },
    {
      name: "allowedTools listing another tool",
      seed: () => {
        upsertCredentialMetadata(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD, {
          allowedTools: ["bash"],
        });
      },
    },
    {
      // The alias map in tool-policy.ts has no entry canonicalizing to
      // acp_spawn, so this covers alias resolution generically: a legacy alias
      // that canonicalizes to some OTHER capability must still deny.
      name: "allowedTools listing a legacy alias for another capability",
      seed: () => {
        upsertCredentialMetadata(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD, {
          allowedTools: ["browser_fill_credential"],
        });
      },
    },
    {
      name: "acp_spawn allowed but domain-restricted",
      seed: () => {
        upsertCredentialMetadata(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD, {
          allowedTools: [ACP_SPAWN_TOOL],
          allowedDomains: ["api.anthropic.com"],
        });
      },
    },
    {
      // The ensure-repair grants acp_spawn but must not drop the domain policy,
      // so the projection has to preserve the rest of the record.
      name: "empty allowedTools and domain-restricted",
      seed: () => {
        upsertCredentialMetadata(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD, {
          allowedTools: [],
          allowedDomains: ["api.anthropic.com"],
        });
      },
    },
    {
      name: "acp_spawn allowed with an explicitly empty allowedDomains",
      seed: () => {
        upsertCredentialMetadata(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD, {
          allowedTools: [ACP_SPAWN_TOOL],
          allowedDomains: [],
        });
      },
    },
  ];

  for (const state of STATES) {
    test(`predicts the spawn read for: ${state.name}`, async () => {
      await seedVaultToken("sk-ant-oat01-parity");

      state.seed();
      const beforePrediction = oauthMetadata();
      const predicted = acpSpawnCredentialDenialReason(ACP_OAUTH_TOKEN_FIELD);
      // The status route is a GET: predicting must not touch the store.
      expect(oauthMetadata()).toEqual(beforePrediction);

      // ensureAcpCredentialPolicy mutates the store, so the actual run starts
      // from a fresh copy of the same state rather than the predicted one.
      deleteCredentialMetadata(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD);
      state.seed();
      ensureAcpCredentialPolicy(ACP_OAUTH_TOKEN_FIELD, "desc");
      const result = await credentialBroker.serverUse<void>({
        service: ACP_SERVICE,
        field: ACP_OAUTH_TOKEN_FIELD,
        toolName: ACP_SPAWN_TOOL,
        execute: async () => {},
      });

      expect(predicted).toBe(result.success ? undefined : result.reason);
    });
  }
});
