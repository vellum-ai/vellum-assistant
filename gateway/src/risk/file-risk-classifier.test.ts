import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import type { FileClassificationContext } from "./file-risk-classifier.js";
import {
  type FileClassifierInput,
  FileRiskClassifier,
  fileRiskClassifier,
} from "./file-risk-classifier.js";

// -- Test context -------------------------------------------------------------

const MOCK_PROTECTED_DIR = join(homedir(), ".vellum", "protected");
const MOCK_DEPRECATED_DIR = join(
  homedir(),
  ".vellum",
  "workspace",
  "deprecated",
);
const MOCK_WORKSPACE_DIR = join(homedir(), ".vellum", "workspace");
const MOCK_HOOKS_DIR = join(MOCK_WORKSPACE_DIR, "hooks");
const MOCK_PLUGINS_DIR = join(MOCK_WORKSPACE_DIR, "plugins");
const MOCK_TOOLS_DIR = join(MOCK_WORKSPACE_DIR, "tools");
const MOCK_ROUTES_DIR = join(MOCK_WORKSPACE_DIR, "routes");
const MOCK_WORKFLOWS_DIR = join(MOCK_WORKSPACE_DIR, "workflows");
const MOCK_MONITORING_DIR = join(MOCK_WORKSPACE_DIR, "data", "monitoring");

/** Skill source paths managed per-test via the context's skillSourceDirs. */
let testSkillSourceDirs: string[] = [];

function makeContext(): FileClassificationContext {
  return {
    protectedDir: MOCK_PROTECTED_DIR,
    deprecatedDir: MOCK_DEPRECATED_DIR,
    hooksDir: MOCK_HOOKS_DIR,
    pluginsDir: MOCK_PLUGINS_DIR,
    toolsDir: MOCK_TOOLS_DIR,
    routesDir: MOCK_ROUTES_DIR,
    workflowsDir: MOCK_WORKFLOWS_DIR,
    monitoringDir: MOCK_MONITORING_DIR,
    skillSourceDirs: testSkillSourceDirs,
  };
}

// -- Helpers ------------------------------------------------------------------

function makeClassifier(): FileRiskClassifier {
  return new FileRiskClassifier();
}

const WORKING_DIR = "/home/user/project";

function classifyInput(
  input: Partial<FileClassifierInput> & Pick<FileClassifierInput, "toolName">,
) {
  return makeClassifier().classify(
    {
      filePath: input.filePath ?? "",
      workingDir: input.workingDir ?? WORKING_DIR,
      toolName: input.toolName,
      resolvedPath: input.resolvedPath,
      transferSandboxDestPath: input.transferSandboxDestPath,
      transferSandboxWorkingDir: input.transferSandboxWorkingDir,
      resolvedTransferDestPath: input.resolvedTransferDestPath,
    },
    makeContext(),
  );
}

// -- Tests --------------------------------------------------------------------

describe("FileRiskClassifier", () => {
  // -- file_read --------------------------------------------------------------

  describe("file_read", () => {
    test("default risk is low", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_read",
        filePath: "src/index.ts",
      });
      expect(result.riskLevel).toBe("low");
      expect(result.reason).toBe("File read (default)");
      expect(result.matchType).toBe("registry");
      expect(result.scopeOptions).toEqual([]);
    });

    test("empty filePath is low", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_read",
        filePath: "",
      });
      expect(result.riskLevel).toBe("low");
    });

    test("actor token signing key in protected dir is high", async () => {
      testSkillSourceDirs = [];
      const signingKeyPath = join(
        MOCK_PROTECTED_DIR,
        "actor-token-signing-key",
      );
      const result = await classifyInput({
        toolName: "file_read",
        filePath: signingKeyPath,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Reads actor token signing key");
    });

    test("actor token signing key in legacy home dir is high", async () => {
      testSkillSourceDirs = [];
      const legacyPath = join(
        homedir(),
        ".vellum",
        "protected",
        "actor-token-signing-key",
      );
      const result = await classifyInput({
        toolName: "file_read",
        filePath: legacyPath,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
    });

    test("actor token signing key in deprecated dir is high", async () => {
      testSkillSourceDirs = [];
      const deprecatedPath = join(
        MOCK_DEPRECATED_DIR,
        "actor-token-signing-key",
      );
      const result = await classifyInput({
        toolName: "file_read",
        filePath: deprecatedPath,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
    });

    test("relative deprecated/actor-token-signing-key resolved against workingDir is high", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_read",
        filePath: "deprecated/actor-token-signing-key",
        workingDir: WORKING_DIR,
      });
      // The resolved path is WORKING_DIR/deprecated/actor-token-signing-key
      // which matches resolve(workingDir, "deprecated", "actor-token-signing-key")
      expect(result.riskLevel).toBe("high");
    });

    test("other protected dir files are low", async () => {
      testSkillSourceDirs = [];
      const otherPath = join(MOCK_PROTECTED_DIR, "some-other-key");
      const result = await classifyInput({
        toolName: "file_read",
        filePath: otherPath,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("low");
    });

    test("monitoring directory snapshot is high", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_read",
        filePath: join(MOCK_MONITORING_DIR, "snapshots", "baseline-123.json"),
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Reads monitoring directory (snapshot data)");
    });

    test("monitoring directory itself is high", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_read",
        filePath: MOCK_MONITORING_DIR,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Reads monitoring directory (snapshot data)");
    });
  });

  // -- file_write -------------------------------------------------------------

  describe("file_write", () => {
    test("default risk is low", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: "src/index.ts",
      });
      expect(result.riskLevel).toBe("low");
      expect(result.reason).toBe("File write (default)");
      expect(result.matchType).toBe("registry");
    });

    test("empty filePath is low", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: "",
      });
      expect(result.riskLevel).toBe("low");
    });

    test("skill source path is high", async () => {
      const skillDir = resolve(WORKING_DIR, "skills/my-skill");
      testSkillSourceDirs = [skillDir];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: "skills/my-skill/SKILL.md",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to skill source code");
      testSkillSourceDirs = [];
    });

    test("hooks directory itself is high", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: MOCK_HOOKS_DIR,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to hooks directory");
    });

    test("file inside hooks directory is high", async () => {
      testSkillSourceDirs = [];
      const hookFile = join(MOCK_HOOKS_DIR, "pre-tool-use.sh");
      const result = await classifyInput({
        toolName: "file_write",
        filePath: hookFile,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to hooks directory");
    });

    // Plugins directory escalation. The external plugin loader auto-imports
    // register.{ts,js} on daemon startup, so a routine file_write here could
    // plant persistent code execution.
    test("plugins directory itself is high", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: MOCK_PLUGINS_DIR,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to plugins directory");
    });

    test("register.ts inside plugins directory is high", async () => {
      testSkillSourceDirs = [];
      const registerFile = join(MOCK_PLUGINS_DIR, "evil-plugin", "register.ts");
      const result = await classifyInput({
        toolName: "file_write",
        filePath: registerFile,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to plugins directory");
    });

    test("package.json inside plugins directory is high", async () => {
      testSkillSourceDirs = [];
      const pkgFile = join(MOCK_PLUGINS_DIR, "evil-plugin", "package.json");
      const result = await classifyInput({
        toolName: "file_write",
        filePath: pkgFile,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to plugins directory");
    });

    test("path containing 'plugins' substring outside plugins dir is low", async () => {
      // Guard against substring matching: a path like /workspace/plugins-data/
      // must NOT escalate, only paths under the exact plugins dir do.
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: join(homedir(), ".vellum", "workspace", "plugins-data", "x"),
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("low");
    });

    test("non-skill, non-hooks path is low", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: "/tmp/output.txt",
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("low");
    });

    // Tools directory escalation. The workspace-tool loader (and its live file
    // watcher) dynamic-imports any <name>.{ts,js} written here and registers it
    // as an executable tool, so a routine file_write here is code injection.
    test("tools directory itself is high", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: MOCK_TOOLS_DIR,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to tools directory");
    });

    test("tool override inside tools directory is high", async () => {
      testSkillSourceDirs = [];
      const toolFile = join(MOCK_TOOLS_DIR, "evil_tool.ts");
      const result = await classifyInput({
        toolName: "file_write",
        filePath: toolFile,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to tools directory");
    });

    test("path containing 'tools' substring outside tools dir is low", async () => {
      // Guard against substring matching: /workspace/tools-data/ must NOT escalate.
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: join(homedir(), ".vellum", "workspace", "tools-data", "x"),
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("low");
    });

    // Routes directory escalation. The user-route dispatcher dynamic-imports
    // handler modules here and executes their exported HTTP-method functions.
    test("routes directory itself is high", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: MOCK_ROUTES_DIR,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to routes directory");
    });

    test("handler inside routes directory is high", async () => {
      testSkillSourceDirs = [];
      const routeFile = join(MOCK_ROUTES_DIR, "evil.ts");
      const result = await classifyInput({
        toolName: "file_write",
        filePath: routeFile,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to routes directory");
    });

    // Workflows directory escalation: a file here is a saved workflow whose
    // source is executed later, so a routine file_write is code injection.
    test("workflows directory itself is high", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: MOCK_WORKFLOWS_DIR,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to workflows directory");
    });

    test("directory-style entrypoint inside workflows dir is high", async () => {
      testSkillSourceDirs = [];
      const entrypoint = join(MOCK_WORKFLOWS_DIR, "victim", "workflow.ts");
      const result = await classifyInput({
        toolName: "file_write",
        filePath: entrypoint,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to workflows directory");
    });

    test("flat workflow file inside workflows dir is high", async () => {
      testSkillSourceDirs = [];
      const flat = join(MOCK_WORKFLOWS_DIR, "victim.workflow.ts");
      const result = await classifyInput({
        toolName: "file_write",
        filePath: flat,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to workflows directory");
    });

    test("path containing 'workflows' substring outside workflows dir is low", async () => {
      // Guard against substring matching: /workspace/workflows-data/ must NOT escalate.
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: join(
          homedir(),
          ".vellum",
          "workspace",
          "workflows-data",
          "x",
        ),
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("low");
    });

    // Container-style /workspace paths must be remapped to the working dir
    // before the containment check — otherwise "/workspace/tools/evil.ts"
    // resolves to the literal path (never matching the real tools dir) and
    // falls through to Low, silently bypassing escalation.
    test("/workspace-prefixed tools path is remapped and high", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: "/workspace/tools/evil.ts",
        workingDir: MOCK_WORKSPACE_DIR,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to tools directory");
    });

    test("/workspace-prefixed routes path is remapped and high", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: "/workspace/routes/evil.ts",
        workingDir: MOCK_WORKSPACE_DIR,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to routes directory");
    });

    test("/workspace-prefixed workflows path is remapped and high", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: "/workspace/workflows/victim/workflow.ts",
        workingDir: MOCK_WORKSPACE_DIR,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to workflows directory");
    });

    test("relative tools path resolves against working dir and is high", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: "tools/evil.ts",
        workingDir: MOCK_WORKSPACE_DIR,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to tools directory");
    });

    // -- monitoring directory (sentinel trust surface) ---------------------

    test("monitoring directory itself is high", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: MOCK_MONITORING_DIR,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to monitoring directory");
    });

    test("sentinel file inside monitoring dir is high", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: join(MOCK_MONITORING_DIR, "plugin-source-versions.json"),
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to monitoring directory");
    });

    test("path containing 'monitoring' substring outside monitoring dir is low", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: join(
          homedir(),
          ".vellum",
          "workspace",
          "monitoring-data",
          "x",
        ),
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("low");
    });
  });

  describe("file_edit", () => {
    test("default risk is low", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_edit",
        filePath: "src/index.ts",
      });
      expect(result.riskLevel).toBe("low");
      expect(result.reason).toBe("File edit (default)");
    });

    test("skill source path is high", async () => {
      const skillDir = resolve(WORKING_DIR, "skills/my-skill");
      testSkillSourceDirs = [skillDir];
      const result = await classifyInput({
        toolName: "file_edit",
        filePath: "skills/my-skill/index.ts",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to skill source code");
      testSkillSourceDirs = [];
    });

    test("hooks directory path is high", async () => {
      testSkillSourceDirs = [];
      const hookFile = join(MOCK_HOOKS_DIR, "post-tool-use.sh");
      const result = await classifyInput({
        toolName: "file_edit",
        filePath: hookFile,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to hooks directory");
    });

    test("plugins directory path is high", async () => {
      testSkillSourceDirs = [];
      const registerFile = join(MOCK_PLUGINS_DIR, "evil-plugin", "register.ts");
      const result = await classifyInput({
        toolName: "file_edit",
        filePath: registerFile,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to plugins directory");
    });

    test("tools directory path is high", async () => {
      testSkillSourceDirs = [];
      const toolFile = join(MOCK_TOOLS_DIR, "evil_tool.ts");
      const result = await classifyInput({
        toolName: "file_edit",
        filePath: toolFile,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to tools directory");
    });

    test("routes directory path is high", async () => {
      testSkillSourceDirs = [];
      const routeFile = join(MOCK_ROUTES_DIR, "evil.ts");
      const result = await classifyInput({
        toolName: "file_edit",
        filePath: routeFile,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to routes directory");
    });
  });

  // -- host_file_read ---------------------------------------------------------

  describe("host_file_read", () => {
    test("always medium (tool registry default)", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "host_file_read",
        filePath: "/etc/passwd",
      });
      expect(result.riskLevel).toBe("medium");
      expect(result.reason).toBe("Host file read (default)");
      expect(result.matchType).toBe("registry");
    });

    test("medium even for empty path", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "host_file_read",
        filePath: "",
      });
      expect(result.riskLevel).toBe("medium");
    });

    test("medium even for actor token signing key path", async () => {
      testSkillSourceDirs = [];
      // host_file_read has no escalation paths — it's always medium.
      const signingKeyPath = join(
        MOCK_PROTECTED_DIR,
        "actor-token-signing-key",
      );
      const result = await classifyInput({
        toolName: "host_file_read",
        filePath: signingKeyPath,
      });
      expect(result.riskLevel).toBe("medium");
    });
  });

  // -- host_file_write --------------------------------------------------------

  describe("host_file_write", () => {
    test("default risk is medium", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "host_file_write",
        filePath: "/tmp/output.txt",
      });
      expect(result.riskLevel).toBe("medium");
      expect(result.reason).toBe("Host file write (default)");
      expect(result.matchType).toBe("registry");
    });

    test("empty filePath is medium", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "host_file_write",
        filePath: "",
      });
      expect(result.riskLevel).toBe("medium");
    });

    test("skill source path is high", async () => {
      // Host tools resolve with resolve(filePath) — no workingDir prefix.
      const absSkillPath = "/home/user/skills/evil-skill/SKILL.md";
      const skillDir = "/home/user/skills/evil-skill";
      testSkillSourceDirs = [skillDir];
      const result = await classifyInput({
        toolName: "host_file_write",
        filePath: absSkillPath,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to skill source code");
      testSkillSourceDirs = [];
    });

    test("hooks directory is high", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "host_file_write",
        filePath: MOCK_HOOKS_DIR,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to hooks directory");
    });

    test("file inside hooks directory is high", async () => {
      testSkillSourceDirs = [];
      const hookFile = join(MOCK_HOOKS_DIR, "pre-tool-use.sh");
      const result = await classifyInput({
        toolName: "host_file_write",
        filePath: hookFile,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to hooks directory");
    });

    test("plugins directory is high", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "host_file_write",
        filePath: MOCK_PLUGINS_DIR,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to plugins directory");
    });

    test("register.ts inside plugins directory is high", async () => {
      testSkillSourceDirs = [];
      const registerFile = join(MOCK_PLUGINS_DIR, "evil-plugin", "register.ts");
      const result = await classifyInput({
        toolName: "host_file_write",
        filePath: registerFile,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to plugins directory");
    });

    test("tools directory is high", async () => {
      testSkillSourceDirs = [];
      const toolFile = join(MOCK_TOOLS_DIR, "evil_tool.ts");
      const result = await classifyInput({
        toolName: "host_file_write",
        filePath: toolFile,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to tools directory");
    });

    test("routes directory is high", async () => {
      testSkillSourceDirs = [];
      const routeFile = join(MOCK_ROUTES_DIR, "evil.ts");
      const result = await classifyInput({
        toolName: "host_file_write",
        filePath: routeFile,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to routes directory");
    });
  });

  // -- host_file_edit ---------------------------------------------------------

  describe("host_file_edit", () => {
    test("default risk is medium", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "host_file_edit",
        filePath: "/tmp/output.txt",
      });
      expect(result.riskLevel).toBe("medium");
      expect(result.reason).toBe("Host file edit (default)");
    });

    test("skill source path is high", async () => {
      const absSkillPath = "/home/user/skills/evil-skill/index.ts";
      const skillDir = "/home/user/skills/evil-skill";
      testSkillSourceDirs = [skillDir];
      const result = await classifyInput({
        toolName: "host_file_edit",
        filePath: absSkillPath,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to skill source code");
      testSkillSourceDirs = [];
    });

    test("hooks directory path is high", async () => {
      testSkillSourceDirs = [];
      const hookFile = join(MOCK_HOOKS_DIR, "post-tool-use.sh");
      const result = await classifyInput({
        toolName: "host_file_edit",
        filePath: hookFile,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to hooks directory");
    });

    test("plugins directory path is high", async () => {
      testSkillSourceDirs = [];
      const registerFile = join(MOCK_PLUGINS_DIR, "evil-plugin", "register.ts");
      const result = await classifyInput({
        toolName: "host_file_edit",
        filePath: registerFile,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to plugins directory");
    });

    test("tools directory path is high", async () => {
      testSkillSourceDirs = [];
      const toolFile = join(MOCK_TOOLS_DIR, "evil_tool.ts");
      const result = await classifyInput({
        toolName: "host_file_edit",
        filePath: toolFile,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to tools directory");
    });

    test("routes directory path is high", async () => {
      testSkillSourceDirs = [];
      const routeFile = join(MOCK_ROUTES_DIR, "evil.ts");
      const result = await classifyInput({
        toolName: "host_file_edit",
        filePath: routeFile,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to routes directory");
    });
  });

  // -- host_file_transfer ------------------------------------------------------

  describe("host_file_transfer", () => {
    test("default risk is medium", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "host_file_transfer",
        filePath: "/tmp/output.txt",
      });
      expect(result.riskLevel).toBe("medium");
      expect(result.reason).toBe("Host file transfer (default)");
      expect(result.matchType).toBe("registry");
    });

    test("empty filePath is medium", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "host_file_transfer",
        filePath: "",
      });
      expect(result.riskLevel).toBe("medium");
    });

    test("skill source path is high", async () => {
      const absSkillPath = "/home/user/skills/evil-skill/SKILL.md";
      const skillDir = "/home/user/skills/evil-skill";
      testSkillSourceDirs = [skillDir];
      const result = await classifyInput({
        toolName: "host_file_transfer",
        filePath: absSkillPath,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Transfers to skill source code");
      testSkillSourceDirs = [];
    });

    test("hooks directory is high", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "host_file_transfer",
        filePath: MOCK_HOOKS_DIR,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Transfers to hooks directory");
    });

    test("file inside hooks directory is high", async () => {
      testSkillSourceDirs = [];
      const hookFile = join(MOCK_HOOKS_DIR, "pre-tool-use.sh");
      const result = await classifyInput({
        toolName: "host_file_transfer",
        filePath: hookFile,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Transfers to hooks directory");
    });

    test("plugins directory is high", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "host_file_transfer",
        filePath: MOCK_PLUGINS_DIR,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Transfers to plugins directory");
    });

    test("register.ts inside plugins directory is high", async () => {
      testSkillSourceDirs = [];
      const registerFile = join(MOCK_PLUGINS_DIR, "evil-plugin", "register.ts");
      const result = await classifyInput({
        toolName: "host_file_transfer",
        filePath: registerFile,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Transfers to plugins directory");
    });

    test("tools directory is high", async () => {
      testSkillSourceDirs = [];
      const toolFile = join(MOCK_TOOLS_DIR, "evil_tool.ts");
      const result = await classifyInput({
        toolName: "host_file_transfer",
        filePath: toolFile,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Transfers to tools directory");
    });

    test("routes directory is high", async () => {
      testSkillSourceDirs = [];
      const routeFile = join(MOCK_ROUTES_DIR, "evil.ts");
      const result = await classifyInput({
        toolName: "host_file_transfer",
        filePath: routeFile,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Transfers to routes directory");
    });

    // to_sandbox: `filePath` carries the benign host source, but the workspace
    // destination is the code-injection sink and must be classified.
    test("to_sandbox dest in tools directory is high", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "host_file_transfer",
        filePath: "/tmp/payload.ts",
        transferSandboxDestPath: "tools/evil.ts",
        transferSandboxWorkingDir: MOCK_WORKSPACE_DIR,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Transfers to tools directory");
    });

    test("to_sandbox dest in routes directory (/workspace path) is high", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "host_file_transfer",
        filePath: "/tmp/payload.ts",
        transferSandboxDestPath: "/workspace/routes/evil.ts",
        transferSandboxWorkingDir: MOCK_WORKSPACE_DIR,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Transfers to routes directory");
    });

    test("to_sandbox dest outside sinks stays medium", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "host_file_transfer",
        filePath: "/tmp/payload.txt",
        transferSandboxDestPath: "scratch/output.txt",
        transferSandboxWorkingDir: MOCK_WORKSPACE_DIR,
      });
      expect(result.riskLevel).toBe("medium");
      expect(result.reason).toBe("Host file transfer (default)");
    });
  });

  // -- Symlink resolution (resolvedPath) --------------------------------------
  //
  // The classifier escalates risk by lexically prefix-matching the target path
  // against protected directories. Lexical resolution does not follow symlinks,
  // so a symlink whose name looks benign but whose real target is a protected
  // directory would be under-classified. The daemon canonicalizes the target
  // with realpath and forwards it as `resolvedPath`; the classifier escalates
  // on that resolved path instead of the lexical one.
  describe("symlink resolution via resolvedPath", () => {
    test("file_write escalates when resolvedPath lands in hooks dir", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        // Benign-looking name in the workspace…
        filePath: "notes.txt",
        workingDir: WORKING_DIR,
        // …but it is a symlink whose real target is inside the hooks dir.
        resolvedPath: join(MOCK_HOOKS_DIR, "pre-tool-use.sh"),
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to hooks directory");
    });

    test("file_write escalates when resolvedPath lands in plugins dir", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: "innocent.json",
        workingDir: WORKING_DIR,
        resolvedPath: join(MOCK_PLUGINS_DIR, "evil-plugin", "register.ts"),
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to plugins directory");
    });

    test("file_edit escalates when resolvedPath lands in skill source", async () => {
      const skillDir = "/home/user/skills/victim-skill";
      testSkillSourceDirs = [skillDir];
      const result = await classifyInput({
        toolName: "file_edit",
        filePath: "scratch.ts",
        workingDir: WORKING_DIR,
        resolvedPath: join(skillDir, "index.ts"),
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to skill source code");
      testSkillSourceDirs = [];
    });

    test("file_read escalates when resolvedPath is the signing key", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_read",
        filePath: "harmless.txt",
        workingDir: WORKING_DIR,
        resolvedPath: join(MOCK_PROTECTED_DIR, "actor-token-signing-key"),
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Reads actor token signing key");
    });

    test("host_file_write escalates when resolvedPath lands in hooks dir", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "host_file_write",
        filePath: "/tmp/notes.txt",
        resolvedPath: join(MOCK_HOOKS_DIR, "pre-tool-use.sh"),
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to hooks directory");
    });

    test("resolvedPath takes precedence over a benign lexical path", async () => {
      // Without resolvedPath this same lexical path would be low; the resolved
      // path is what drives escalation.
      testSkillSourceDirs = [];
      const benign = await classifyInput({
        toolName: "file_write",
        filePath: "notes.txt",
        workingDir: WORKING_DIR,
      });
      expect(benign.riskLevel).toBe("low");

      const escalated = await classifyInput({
        toolName: "file_write",
        filePath: "notes.txt",
        workingDir: WORKING_DIR,
        resolvedPath: join(MOCK_HOOKS_DIR, "evil.sh"),
      });
      expect(escalated.riskLevel).toBe("high");
    });

    test("a benign resolvedPath does not escalate", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: "notes.txt",
        workingDir: WORKING_DIR,
        resolvedPath: "/home/user/project/notes.txt",
      });
      expect(result.riskLevel).toBe("low");
    });

    // Reverse symlink: the path is lexically INSIDE a protected dir but its
    // real target is outside. The loader still executes the file through the
    // protected location, so escalation must fire on the lexical path even
    // though resolvedPath points elsewhere (union of lexical + real).
    test("file_write escalates when lexical path is in hooks dir but resolvedPath points out", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: join(MOCK_HOOKS_DIR, "pre-tool-use.sh"),
        workingDir: "/",
        resolvedPath: "/tmp/elsewhere.sh",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to hooks directory");
    });

    test("file_read escalates when lexical path is the signing key but resolvedPath points out", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_read",
        filePath: join(MOCK_PROTECTED_DIR, "actor-token-signing-key"),
        workingDir: "/",
        resolvedPath: "/tmp/elsewhere",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Reads actor token signing key");
    });

    test("host_file_write escalates when lexical path is in plugins dir but resolvedPath points out", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "host_file_write",
        filePath: join(MOCK_PLUGINS_DIR, "evil", "register.ts"),
        resolvedPath: "/tmp/elsewhere.ts",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to plugins directory");
    });
  });

  // -- Singleton export -------------------------------------------------------

  describe("singleton", () => {
    test("fileRiskClassifier is an instance of FileRiskClassifier", () => {
      expect(fileRiskClassifier).toBeInstanceOf(FileRiskClassifier);
    });

    test("singleton produces same results as new instance", async () => {
      testSkillSourceDirs = [];
      const ctx = makeContext();
      const singletonResult = await fileRiskClassifier.classify(
        {
          toolName: "file_read",
          filePath: "src/index.ts",
          workingDir: WORKING_DIR,
        },
        ctx,
      );
      const freshResult = await makeClassifier().classify(
        {
          toolName: "file_read",
          filePath: "src/index.ts",
          workingDir: WORKING_DIR,
        },
        ctx,
      );
      expect(singletonResult).toEqual(freshResult);
    });
  });

  // -- Path resolution behavior -----------------------------------------------

  describe("path resolution", () => {
    test("sandbox tools resolve paths relative to workingDir", async () => {
      // file_write with a relative skill path resolved against workingDir
      const relPath = "my-skills/test-skill/SKILL.md";
      const skillDir = resolve(WORKING_DIR, "my-skills/test-skill");
      testSkillSourceDirs = [skillDir];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: relPath,
        workingDir: WORKING_DIR,
      });
      expect(result.riskLevel).toBe("high");
      testSkillSourceDirs = [];
    });

    test("host tools resolve paths without workingDir", async () => {
      // host_file_write resolves with resolve(filePath) — workingDir is ignored.
      const absPath = "/absolute/skill-path/SKILL.md";
      const skillDir = "/absolute/skill-path";
      testSkillSourceDirs = [skillDir];
      const result = await classifyInput({
        toolName: "host_file_write",
        filePath: absPath,
        // Even though workingDir is set, host tools ignore it
        workingDir: "/some/other/dir",
      });
      expect(result.riskLevel).toBe("high");
      testSkillSourceDirs = [];
    });
  });

  // -- Allowlist options ------------------------------------------------------

  describe("allowlistOptions", () => {
    test("file_read produces exact file + ancestor dirs + wildcard", async () => {
      testSkillSourceDirs = [];
      const filePath = "/home/user/project/src/index.ts";
      const result = await classifyInput({
        toolName: "file_read",
        filePath,
        workingDir: "/",
      });
      const opts = result.allowlistOptions!;
      expect(opts).toBeDefined();
      expect(opts.length).toBeGreaterThanOrEqual(2);

      // First option is exact file
      expect(opts[0]).toEqual({
        label: filePath,
        description: "This file only",
        pattern: `file_read:${filePath}`,
      });

      // Ancestor directory wildcards
      let dir = dirname(filePath);
      let i = 1;
      const maxLevels = 3;
      let levels = 0;
      while (dir && dir !== "/" && dir !== "." && levels < maxLevels) {
        const dirName = dir.split("/").pop() || dir;
        expect(opts[i]).toEqual({
          label: `${dir}/**`,
          description: `Anything in ${dirName}/`,
          pattern: `file_read:${dir}/**`,
        });
        const parent = dirname(dir);
        if (parent === dir || dir === homedir()) break;
        dir = parent;
        i++;
        levels++;
      }

      // Last option is the tool wildcard
      expect(opts[opts.length - 1]).toEqual({
        label: "file_read:*",
        description: "All file reads",
        pattern: "file_read:*",
      });
    });

    test("file_write produces options for the given path", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: "/tmp/output.txt",
        workingDir: "/",
      });
      const opts = result.allowlistOptions!;
      expect(opts).toBeDefined();
      expect(opts[0].pattern).toBe("file_write:/tmp/output.txt");
      expect(opts[opts.length - 1].pattern).toBe("file_write:*");
      expect(opts[opts.length - 1].description).toBe("All file writes");
    });

    test("host_file_read produces options", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "host_file_read",
        filePath: "/etc/config.json",
        workingDir: "/",
      });
      const opts = result.allowlistOptions!;
      expect(opts).toBeDefined();
      expect(opts[0].pattern).toBe("host_file_read:/etc/config.json");
      expect(opts[opts.length - 1].description).toBe("All host file reads");
    });

    test("empty filePath produces empty allowlistOptions", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_read",
        filePath: "",
      });
      expect(result.allowlistOptions).toEqual([]);
    });
  });
});
