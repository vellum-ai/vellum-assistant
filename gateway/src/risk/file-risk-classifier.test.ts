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
const MOCK_HOOKS_DIR = join(homedir(), ".vellum", "workspace", "hooks");

/** Skill source paths managed per-test via the context's skillSourceDirs. */
let testSkillSourceDirs: string[] = [];

function makeContext(): FileClassificationContext {
  return {
    protectedDir: MOCK_PROTECTED_DIR,
    deprecatedDir: MOCK_DEPRECATED_DIR,
    hooksDir: MOCK_HOOKS_DIR,
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

    test("non-skill, non-hooks path is low", async () => {
      testSkillSourceDirs = [];
      const result = await classifyInput({
        toolName: "file_write",
        filePath: "/tmp/output.txt",
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("low");
    });
  });

  // -- file_edit --------------------------------------------------------------

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
