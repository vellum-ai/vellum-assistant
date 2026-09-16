import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { runInPluginContext } from "../../plugins/plugin-execution-context.js";
import {
  derivePluginNameFromProcess,
  derivePluginNameFromSkillScriptPath,
  PLUGIN_NAME_ENV,
  readPluginNameFromEnv,
  resolveCallingPluginName,
} from "../plugin-name-env.js";

const pluginsDir = "/tmp/vellum-workspace/plugins";

describe("readPluginNameFromEnv", () => {
  test("returns a trimmed install name", () => {
    expect(readPluginNameFromEnv({ [PLUGIN_NAME_ENV]: "  sms  " })).toBe("sms");
  });

  test("ignores empty or whitespace-only values", () => {
    expect(readPluginNameFromEnv({ [PLUGIN_NAME_ENV]: "" })).toBeUndefined();
    expect(readPluginNameFromEnv({ [PLUGIN_NAME_ENV]: "   " })).toBeUndefined();
    expect(readPluginNameFromEnv({})).toBeUndefined();
  });
});

describe("derivePluginNameFromSkillScriptPath", () => {
  test("returns the plugin install name for a scripts path", () => {
    expect(
      derivePluginNameFromSkillScriptPath(
        join(pluginsDir, "sms/skills/sms-setup/scripts/twilio-numbers.ts"),
        pluginsDir,
      ),
    ).toBe("sms");
  });

  test("returns the plugin install name for a tools path", () => {
    expect(
      derivePluginNameFromSkillScriptPath(
        join(pluginsDir, "sms/skills/sms-setup/tools/list.ts"),
        pluginsDir,
      ),
    ).toBe("sms");
  });

  test("accepts a file URL", () => {
    const filePath = join(
      pluginsDir,
      "sms/skills/sms-setup/scripts/twilio-numbers.ts",
    );
    expect(
      derivePluginNameFromSkillScriptPath(`file://${filePath}`, pluginsDir),
    ).toBe("sms");
  });

  test("rejects a path outside plugins/", () => {
    expect(
      derivePluginNameFromSkillScriptPath(
        "/tmp/other/skills/sms-setup/scripts/twilio-numbers.ts",
        pluginsDir,
      ),
    ).toBeUndefined();
  });

  test("rejects a plugin file that is not under scripts/ or tools/", () => {
    expect(
      derivePluginNameFromSkillScriptPath(
        join(pluginsDir, "sms/skills/sms-setup/SKILL.md"),
        pluginsDir,
      ),
    ).toBeUndefined();
    expect(
      derivePluginNameFromSkillScriptPath(
        join(pluginsDir, "sms/register.ts"),
        pluginsDir,
      ),
    ).toBeUndefined();
  });

  test("rejects a truncated plugins path", () => {
    expect(
      derivePluginNameFromSkillScriptPath(
        join(pluginsDir, "sms/skills/scripts/too-short.ts"),
        pluginsDir,
      ),
    ).toBeUndefined();
  });
});

describe("derivePluginNameFromProcess", () => {
  test("scans argv for a plugin-resident skill script", () => {
    expect(
      derivePluginNameFromProcess(
        ["bun", join(pluginsDir, "sms/skills/sms-setup/scripts/twilio-numbers.ts")],
        "/tmp",
        pluginsDir,
      ),
    ).toBe("sms");
  });

  test("resolves a relative argv path against cwd", () => {
    expect(
      derivePluginNameFromProcess(
        ["bun", "sms/skills/sms-setup/scripts/twilio-numbers.ts"],
        pluginsDir,
        pluginsDir,
      ),
    ).toBe("sms");
  });

  test("skips flags", () => {
    expect(
      derivePluginNameFromProcess(
        ["bun", "--hot", join(pluginsDir, "sms/skills/sms-setup/scripts/twilio-numbers.ts")],
        "/tmp",
        pluginsDir,
      ),
    ).toBe("sms");
  });
});

describe("resolveCallingPluginName", () => {
  const prior = process.env[PLUGIN_NAME_ENV];

  afterEach(() => {
    if (prior === undefined) {
      delete process.env[PLUGIN_NAME_ENV];
    } else {
      process.env[PLUGIN_NAME_ENV] = prior;
    }
  });

  test("prefers AsyncLocalStorage over env", () => {
    process.env[PLUGIN_NAME_ENV] = "from-env";
    const name = runInPluginContext("from-als", () =>
      resolveCallingPluginName(process.env, [], "/tmp"),
    );
    expect(name).toBe("from-als");
  });

  test("uses VELLUM_PLUGIN_NAME when ALS is empty", () => {
    expect(
      resolveCallingPluginName({ [PLUGIN_NAME_ENV]: "sms" }, [], "/tmp"),
    ).toBe("sms");
  });

  test("falls back to the process entry path", () => {
    expect(
      resolveCallingPluginName(
        {},
        ["bun", join(pluginsDir, "sms/skills/sms-setup/scripts/twilio-numbers.ts")],
        "/tmp",
        pluginsDir,
      ),
    ).toBe("sms");
  });
});

describe("resolveCallingPluginName real child", () => {
  test("recovers the plugin name from a scripts path without env", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "plugin-name-child-"));
    const scriptDir = join(
      workspace,
      "plugins/sms/skills/sms-setup/scripts",
    );
    mkdirSync(scriptDir, { recursive: true });
    const helper = join(
      import.meta.dir,
      "..",
      "plugin-name-env.ts",
    );
    const scriptPath = join(scriptDir, "echo-plugin-name.ts");
    writeFileSync(
      scriptPath,
      `import { resolveCallingPluginName } from ${JSON.stringify(helper)};
console.log(JSON.stringify({ name: resolveCallingPluginName() ?? null }));
`,
    );

    try {
      const child = Bun.spawn(
        ["bun", scriptPath],
        {
          cwd: scriptDir,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            VELLUM_WORKSPACE_DIR: workspace,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({ name: "sms" });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 15_000);

  test("recovers the plugin name from VELLUM_PLUGIN_NAME without a plugin path", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "plugin-name-env-child-"));
    const scriptDir = join(workspace, "scratch");
    mkdirSync(scriptDir, { recursive: true });
    const helper = join(import.meta.dir, "..", "plugin-name-env.ts");
    const scriptPath = join(scriptDir, "echo-plugin-name.ts");
    writeFileSync(
      scriptPath,
      `import { resolveCallingPluginName } from ${JSON.stringify(helper)};
console.log(JSON.stringify({ name: resolveCallingPluginName() ?? null }));
`,
    );

    try {
      const child = Bun.spawn(
        ["bun", scriptPath],
        {
          cwd: scriptDir,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            VELLUM_WORKSPACE_DIR: workspace,
            VELLUM_PLUGIN_NAME: "sms",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual({ name: "sms" });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 15_000);
});
