/**
 * Subprocess integration for plugin-resident skill credential access.
 *
 * Starts a real assistant IPC server and a real Bun child that imports
 * resolveCredential. The child is not given a plugin name or CES catalog;
 * it presents only a daemon-issued grant.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
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

import type { Conversation } from "../daemon/conversation.js";
import {
  clearConversations,
  setConversation,
} from "../daemon/conversation-registry.js";
import { AssistantIpcServer } from "../ipc/assistant-server.js";
import { cliIpcCall } from "../ipc/cli-client.js";
import { PLUGIN_SKILL_INVOCATION_ENV } from "../plugin-api/plugin-skill-grant.js";
import { resolveCredential } from "../plugin-api/resolve-credential.js";
import { runInPluginContext } from "../plugins/plugin-execution-context.js";
import {
  _resetPluginSkillGrantsForTest,
  issuePluginSkillGrant,
} from "../plugins/plugin-skill-invocation.js";
import { runPluginSkillScript } from "../plugins/plugin-skill-script-runner.js";
import * as secureKeys from "../security/secure-keys.js";
import {
  _setMetadataPath,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";
import { getWorkspaceDir, getWorkspacePluginsDir } from "../util/platform.js";

const PLUGIN_DIR = "psk-demo";
const SKILL_ID = "psk-demo-skill";
const CONV_ID = "conv-xyz";
const SECRET = "plugin-owned-secret-value";
const OTHER_SECRET = "github-owned-secret-value";

const META_DIR = join(
  tmpdir(),
  `vellum-psk-int-${randomBytes(4).toString("hex")}`,
);
const META_PATH = join(META_DIR, "metadata.json");

const resolveCredentialHref = new URL(
  "../plugin-api/resolve-credential.ts",
  import.meta.url,
).href;

let server: AssistantIpcServer | null = null;
let secureStore: Map<string, string>;
let getSpy: ReturnType<typeof spyOn>;

function writePluginResolveScript(): void {
  const pluginDir = join(getWorkspacePluginsDir(), PLUGIN_DIR);
  const skillDir = join(pluginDir, "skills", SKILL_ID);
  const scriptsDir = join(skillDir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify({
      name: "authored-package-name",
      version: "1.0.0",
      peerDependencies: { "@vellumai/plugin-api": "*" },
    }),
  );
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${SKILL_ID}\ndescription: Demo plugin skill.\n---\n\nBody.\n`,
  );
  writeFileSync(
    join(scriptsDir, "resolve.ts"),
    `
import { createHash } from "node:crypto";
import { resolveCredential } from ${JSON.stringify(resolveCredentialHref)};

const ref = process.argv[2] ?? "";
try {
  const value = await resolveCredential(ref);
  const digest = createHash("sha256").update(value).digest("hex");
  console.log(JSON.stringify({ ok: true, digest, length: value.length }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
}
`,
  );
}

function activateSkill(): void {
  setConversation(CONV_ID, {
    skillProjectionState: new Map([[SKILL_ID, "v1"]]),
  } as unknown as Conversation);
}

function seedCredential(service: string, field: string, value: string): string {
  const meta = upsertCredentialMetadata(service, field, {});
  secureStore.set(credentialKey(service, field), value);
  return meta.credentialId;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function spawnBareChild(env: NodeJS.ProcessEnv, ref: string) {
  const script = join(
    getWorkspacePluginsDir(),
    PLUGIN_DIR,
    "skills",
    SKILL_ID,
    "scripts",
    "resolve.ts",
  );
  return await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolvePromise) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const child = spawn(process.execPath, [script, ref], {
        cwd: join(getWorkspacePluginsDir(), PLUGIN_DIR, "skills", SKILL_ID),
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdout.on("data", (data: Buffer) => stdoutChunks.push(data));
      child.stderr.on("data", (data: Buffer) => stderrChunks.push(data));
      child.on("close", (code) => {
        resolvePromise({
          stdout: Buffer.concat(stdoutChunks).toString(),
          stderr: Buffer.concat(stderrChunks).toString(),
          exitCode: code ?? 1,
        });
      });
      child.on("error", (err) => {
        resolvePromise({
          stdout: "",
          stderr: err.message,
          exitCode: 1,
        });
      });
    },
  );
}

beforeEach(async () => {
  _resetPluginSkillGrantsForTest();
  clearConversations();
  rmSync(getWorkspacePluginsDir(), { recursive: true, force: true });
  if (existsSync(META_DIR)) {
    rmSync(META_DIR, { recursive: true });
  }
  mkdirSync(META_DIR, { recursive: true });
  _setMetadataPath(META_PATH);
  secureStore = new Map();
  getSpy = spyOn(secureKeys, "getSecureKeyResultAsync").mockImplementation(
    async (key: string) => ({
      value: secureStore.get(key),
      unreachable: false,
    }),
  );
  writePluginResolveScript();
  activateSkill();
  seedCredential(PLUGIN_DIR, "account_sid", SECRET);
  seedCredential("github", "app_id", OTHER_SECRET);
  server = new AssistantIpcServer();
  await server.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
});

afterEach(() => {
  server?.stop();
  server = null;
  getSpy.mockRestore();
  _resetPluginSkillGrantsForTest();
  clearConversations();
});

afterAll(() => {
  _setMetadataPath(null);
  if (existsSync(META_DIR)) {
    rmSync(META_DIR, { recursive: true });
  }
});

describe("plugin skill script credential integration", () => {
  test(
    "a plugin-resident script resolves its own credential and not another service",
    async () => {
      const own = await runPluginSkillScript({
        conversationId: CONV_ID,
        skillId: SKILL_ID,
        script: "scripts/resolve.ts",
        args: [`${PLUGIN_DIR}/account_sid`],
      });
      expect(own.ok).toBe(true);
      if (!own.ok) {
        return;
      }
      expect(own.exitCode).toBe(0);
      const ownPayload = JSON.parse(own.stdout.trim()) as {
        ok: boolean;
        digest?: string;
        error?: string;
      };
      expect(ownPayload.ok).toBe(true);
      expect(ownPayload.digest).toBe(digest(SECRET));
      expect(own.stdout).not.toContain(SECRET);
      expect(own.stderr).not.toContain(SECRET);

      const other = await runPluginSkillScript({
        conversationId: CONV_ID,
        skillId: SKILL_ID,
        script: "scripts/resolve.ts",
        args: ["github/app_id"],
      });
      expect(other.ok).toBe(true);
      if (!other.ok) {
        return;
      }
      expect(other.exitCode).not.toBe(0);
      const otherPayload = JSON.parse(other.stdout.trim()) as {
        ok: boolean;
        error?: string;
      };
      expect(otherPayload.ok).toBe(false);
      expect(otherPayload.error).toMatch(/out of scope/);
      expect(other.stdout).not.toContain(OTHER_SECRET);
      expect(other.stderr).not.toContain(OTHER_SECRET);
    },
    { timeout: 20_000 },
  );

  test(
    "an arbitrary child cannot claim a plugin identity via env or path",
    async () => {
      const result = await spawnBareChild(
        {
          ...process.env,
          VELLUM_PLUGIN_NAME: PLUGIN_DIR,
          VELLUM_PLUGIN_SKILL_INVOCATION: "sms",
          PLUGIN_NAME: PLUGIN_DIR,
        },
        `${PLUGIN_DIR}/account_sid`,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain(SECRET);
      const payload = JSON.parse(result.stdout.trim()) as {
        ok: boolean;
        error?: string;
      };
      expect(payload.ok).toBe(false);
      expect(payload.error).toMatch(/not found|grant|malformed|unknown/i);
    },
    { timeout: 20_000 },
  );

  test(
    "a forged grant token is rejected",
    async () => {
      const result = await spawnBareChild(
        {
          ...process.env,
          [PLUGIN_SKILL_INVOCATION_ENV]: "psk1.deadbeef.forgedsecret",
          __CONVERSATION_ID: CONV_ID,
        },
        `${PLUGIN_DIR}/account_sid`,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain(SECRET);
      const payload = JSON.parse(result.stdout.trim()) as {
        ok: boolean;
        error?: string;
      };
      expect(payload.ok).toBe(false);
      expect(payload.error).toMatch(/unknown|revoked|malformed|grant/i);
    },
    { timeout: 20_000 },
  );

  test(
    "plugin_skill_run over IPC executes the authorized script",
    async () => {
      const result = await cliIpcCall<{
        stdout: string;
        stderr: string;
        exitCode: number;
      }>("plugin_skill_run", {
        body: {
          conversationId: CONV_ID,
          skillId: SKILL_ID,
          script: "scripts/resolve.ts",
          args: [`${PLUGIN_DIR}/account_sid`],
        },
      });
      expect(result.ok).toBe(true);
      expect(result.result?.exitCode).toBe(0);
      const payload = JSON.parse((result.result?.stdout ?? "").trim()) as {
        ok: boolean;
        digest?: string;
      };
      expect(payload.digest).toBe(digest(SECRET));
      expect(result.result?.stdout).not.toContain(SECRET);
    },
    { timeout: 20_000 },
  );

  test("plugin_skill_run rejects a forged nonce", async () => {
    const result = await cliIpcCall("plugin_skill_run", {
      body: {
        conversationId: CONV_ID,
        skillId: SKILL_ID,
        script: "scripts/resolve.ts",
        args: [`${PLUGIN_DIR}/account_sid`],
        revealNonce: "forged-nonce",
      },
    });
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  test("in-process plugin context still wins over a forged grant env", async () => {
    process.env[PLUGIN_SKILL_INVOCATION_ENV] = "psk1.deadbeef.forgedsecret";
    try {
      const value = await runInPluginContext(PLUGIN_DIR, () =>
        resolveCredential(`${PLUGIN_DIR}/account_sid`),
      );
      expect(value).toBe(SECRET);
    } finally {
      delete process.env[PLUGIN_SKILL_INVOCATION_ENV];
    }
  });

  test("issuePluginSkillGrant identity is not taken from the child", async () => {
    const issued = issuePluginSkillGrant({
      conversationId: CONV_ID,
      pluginName: PLUGIN_DIR,
      skillId: SKILL_ID,
    });
    const result = await cliIpcCall<{ value: string }>(
      "plugin_skill_resolve_credential",
      {
        body: {
          grant: issued.token,
          ref: "github/app_id",
          conversationId: CONV_ID,
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(403);
  });
});
