import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import { credentialKey } from "@vellumai/credential-storage";

import {
  formatPluginSkillGrantToken,
  parsePluginSkillGrantToken,
  readPluginSkillGrantToken,
} from "../../plugin-api/plugin-skill-grant.js";
import * as secureKeys from "../../security/secure-keys.js";
import {
  _setMetadataPath,
  upsertCredentialMetadata,
} from "../../tools/credentials/metadata-store.js";
import * as metadataStore from "../../tools/credentials/metadata-store.js";
import {
  _expirePluginSkillGrantForTest,
  _resetPluginSkillGrantsForTest,
  issuePluginSkillGrant,
  resolveCredentialForPluginSkillGrant,
  revokePluginSkillGrant,
  validatePluginSkillGrant,
} from "../plugin-skill-invocation.js";

const TEST_DIR = join(
  tmpdir(),
  `vellum-plugin-skill-grant-${randomBytes(4).toString("hex")}`,
);
const META_PATH = join(TEST_DIR, "metadata.json");

let secureStore: Map<string, string>;
let getSpy: ReturnType<typeof spyOn>;

function seedCredential(service: string, field: string, value: string): string {
  const meta = upsertCredentialMetadata(service, field, {});
  secureStore.set(credentialKey(service, field), value);
  return meta.credentialId;
}

beforeEach(() => {
  _resetPluginSkillGrantsForTest();
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  _setMetadataPath(META_PATH);
  secureStore = new Map();
  getSpy = spyOn(secureKeys, "getSecureKeyResultAsync").mockImplementation(
    async (key: string) => ({
      value: secureStore.get(key),
      unreachable: false,
    }),
  );
});

afterEach(() => {
  getSpy.mockRestore();
  _resetPluginSkillGrantsForTest();
});

afterAll(() => {
  _setMetadataPath(null);
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

describe("plugin skill grant tokens", () => {
  test("parse and format a well-formed token", () => {
    const token = formatPluginSkillGrantToken("abc", "secret");
    expect(token).toBe("psk1.abc.secret");
    expect(parsePluginSkillGrantToken(token)).toEqual({
      grantId: "abc",
      secret: "secret",
    });
  });

  test("rejects malformed tokens", () => {
    expect(parsePluginSkillGrantToken("sms")).toBeUndefined();
    expect(parsePluginSkillGrantToken("psk1.")).toBeUndefined();
    expect(parsePluginSkillGrantToken("psk1.onlyid")).toBeUndefined();
    expect(parsePluginSkillGrantToken("")).toBeUndefined();
  });

  test("readPluginSkillGrantToken ignores a forged plugin name", () => {
    expect(
      readPluginSkillGrantToken({
        VELLUM_PLUGIN_SKILL_INVOCATION: "sms",
      }),
    ).toBeUndefined();
    expect(
      readPluginSkillGrantToken({
        VELLUM_PLUGIN_NAME: "sms",
        VELLUM_PLUGIN_SKILL_INVOCATION: "psk1.dead.beef",
      }),
    ).toBe("psk1.dead.beef");
  });
});

describe("validatePluginSkillGrant", () => {
  test("accepts a freshly issued token", () => {
    const issued = issuePluginSkillGrant({
      conversationId: "conv-xyz",
      pluginName: "psk-demo",
      skillId: "psk-demo-skill",
    });
    const validated = validatePluginSkillGrant(issued.token, {
      conversationId: "conv-xyz",
    });
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.grant.pluginName).toBe("psk-demo");
      expect(validated.grant.conversationId).toBe("conv-xyz");
    }
  });

  test("rejects a malformed token", () => {
    expect(validatePluginSkillGrant("sms").ok).toBe(false);
    if (!validatePluginSkillGrant("not-a-grant").ok) {
      expect(validatePluginSkillGrant("not-a-grant")).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  test("rejects an unknown or forged secret", () => {
    const issued = issuePluginSkillGrant({
      conversationId: "conv-xyz",
      pluginName: "psk-demo",
      skillId: "psk-demo-skill",
    });
    const parsed = parsePluginSkillGrantToken(issued.token);
    expect(parsed).toBeDefined();
    const forged = formatPluginSkillGrantToken(parsed!.grantId, "forged-secret");
    const result = validatePluginSkillGrant(forged);
    expect(result).toEqual({ ok: false, reason: "unknown" });
  });

  test("rejects an expired grant", () => {
    const issued = issuePluginSkillGrant({
      conversationId: "conv-xyz",
      pluginName: "psk-demo",
      skillId: "psk-demo-skill",
    });
    _expirePluginSkillGrantForTest(issued.token);
    expect(validatePluginSkillGrant(issued.token)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("rejects a revoked grant as unknown", () => {
    const issued = issuePluginSkillGrant({
      conversationId: "conv-xyz",
      pluginName: "psk-demo",
      skillId: "psk-demo-skill",
    });
    revokePluginSkillGrant(issued.token);
    expect(validatePluginSkillGrant(issued.token)).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  test("rejects the wrong conversation", () => {
    const issued = issuePluginSkillGrant({
      conversationId: "conv-xyz",
      pluginName: "psk-demo",
      skillId: "psk-demo-skill",
    });
    expect(
      validatePluginSkillGrant(issued.token, { conversationId: "conv-other" }),
    ).toEqual({ ok: false, reason: "wrong_conversation" });
  });

  test("rejects an exhausted grant", async () => {
    const issued = issuePluginSkillGrant({
      conversationId: "conv-xyz",
      pluginName: "psk-demo",
      skillId: "psk-demo-skill",
      maxResolves: 1,
    });
    seedCredential("psk-demo", "account_sid", "sid-secret");
    const first = await resolveCredentialForPluginSkillGrant(
      issued.token,
      "psk-demo/account_sid",
    );
    expect(first.ok).toBe(true);
    const second = await resolveCredentialForPluginSkillGrant(
      issued.token,
      "psk-demo/account_sid",
    );
    expect(second).toMatchObject({
      ok: false,
      reason: "invalid_grant",
    });
    expect(second.ok === false && second.message).toMatch(/remaining/);
  });
});

describe("resolveCredentialForPluginSkillGrant", () => {
  test("resolves a credential under the grant's plugin service", async () => {
    const issued = issuePluginSkillGrant({
      conversationId: "conv-xyz",
      pluginName: "psk-demo",
      skillId: "psk-demo-skill",
    });
    seedCredential("psk-demo", "account_sid", "sid-secret");
    const result = await resolveCredentialForPluginSkillGrant(
      issued.token,
      "psk-demo/account_sid",
    );
    expect(result).toEqual({
      ok: true,
      value: "sid-secret",
      service: "psk-demo",
      field: "account_sid",
    });
  });

  test("rejects another service before reading the secret", async () => {
    const issued = issuePluginSkillGrant({
      conversationId: "conv-xyz",
      pluginName: "psk-demo",
      skillId: "psk-demo-skill",
    });
    seedCredential("github", "app_id", "gh-secret");
    getSpy.mockClear();
    const result = await resolveCredentialForPluginSkillGrant(
      issued.token,
      "github/app_id",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("out_of_scope");
    }
    expect(getSpy).not.toHaveBeenCalled();
  });

  test("rejects a UUID that resolves outside the plugin service", async () => {
    const issued = issuePluginSkillGrant({
      conversationId: "conv-xyz",
      pluginName: "psk-demo",
      skillId: "psk-demo-skill",
    });
    const githubId = seedCredential("github", "app_id", "gh-secret");
    const result = await resolveCredentialForPluginSkillGrant(
      issued.token,
      githubId,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("out_of_scope");
    }
  });

  test("reports an honest unreachable failure, not an empty-cache miss", async () => {
    const issued = issuePluginSkillGrant({
      conversationId: "conv-xyz",
      pluginName: "psk-demo",
      skillId: "psk-demo-skill",
    });
    const liveSpy = spyOn(
      metadataStore,
      "listCredentialRecordsLive",
    ).mockResolvedValue({ records: [], unreachable: true });
    try {
      const result = await resolveCredentialForPluginSkillGrant(
        issued.token,
        "psk-demo/account_sid",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("unreachable");
        expect(result.message).toMatch(/unreachable/i);
        expect(result.message).not.toMatch(/not found/i);
      }
    } finally {
      liveSpy.mockRestore();
    }
  });
});
