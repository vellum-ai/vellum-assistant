import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock the config loader — skill extraDirs is empty by default.
const mockExtraDirs: string[] = [];
mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    skills: { load: { extraDirs: mockExtraDirs } },
  }),
}));

// Mock platform paths to deterministic values for test isolation.
const MOCK_PROTECTED_DIR = join(homedir(), ".vellum", "protected");
const MOCK_DEPRECATED_DIR = join(
  homedir(),
  ".vellum",
  "workspace",
  "deprecated",
);
const MOCK_HOOKS_DIR = join(homedir(), ".vellum", "workspace", "hooks");

mock.module("../util/platform.js", () => ({
  getProtectedDir: () => MOCK_PROTECTED_DIR,
  getDeprecatedDir: () => MOCK_DEPRECATED_DIR,
  getWorkspaceHooksDir: () => MOCK_HOOKS_DIR,
}));

// Mock path-classifier to avoid filesystem-dependent behavior in tests.
// isSkillSourcePath checks whether a path falls under skill directories.
// We control it via a test-local set of "skill paths".
const skillSourcePaths = new Set<string>();
mock.module("../skills/path-classifier.js", () => ({
  isSkillSourcePath: (absPath: string, _extraRoots?: string[]) =>
    skillSourcePaths.has(absPath),
  normalizeDirPath: (dirPath: string) =>
    dirPath.endsWith("/") ? dirPath : dirPath + "/",
  normalizeFilePath: (filePath: string) => filePath,
}));

import {
  type FileClassifierInput,
  FileRiskClassifier,
  fileRiskClassifier,
} from "./file-risk-classifier.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeClassifier(): FileRiskClassifier {
  return new FileRiskClassifier();
}

const WORKING_DIR = "/home/user/project";

function classifyInput(
  input: Partial<FileClassifierInput> & Pick<FileClassifierInput, "toolName">,
) {
  return makeClassifier().classify({
    filePath: input.filePath ?? "",
    workingDir: input.workingDir ?? WORKING_DIR,
    toolName: input.toolName,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("FileRiskClassifier", () => {
  // ── file_read ────────────────────────────────────────────────────────────

  describe("file_read", () => {
    test("default risk is low", async () => {
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
      const result = await classifyInput({
        toolName: "file_read",
        filePath: "",
      });
      expect(result.riskLevel).toBe("low");
    });

    test("actor token signing key in protected dir is high", async () => {
      const signingKeyPath = join(
        MOCK_PROTECTED_DIR,
        "actor-token-signing-key",
      );
      // file_read resolves relative to workingDir, so provide the absolute
      // path as filePath with a workingDir that makes resolve() produce it.
      const result = await classifyInput({
        toolName: "file_read",
        filePath: signingKeyPath,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Reads actor token signing key");
    });

    test("actor token signing key in legacy home dir is high", async () => {
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
      const otherPath = join(MOCK_PROTECTED_DIR, "some-other-key");
      const result = await classifyInput({
        toolName: "file_read",
        filePath: otherPath,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("low");
    });
  });

  // ── file_write ───────────────────────────────────────────────────────────

  describe("file_write", () => {
    test("default risk is low", async () => {
      const result = await classifyInput({
        toolName: "file_write",
        filePath: "src/index.ts",
      });
      expect(result.riskLevel).toBe("low");
      expect(result.reason).toBe("File write (default)");
      expect(result.matchType).toBe("registry");
    });

    test("empty filePath is low", async () => {
      const result = await classifyInput({
        toolName: "file_write",
        filePath: "",
      });
      expect(result.riskLevel).toBe("low");
    });

    test("skill source path is high", async () => {
      const skillPath = resolve(WORKING_DIR, "skills/my-skill/SKILL.md");
      skillSourcePaths.add(skillPath);
      try {
        const result = await classifyInput({
          toolName: "file_write",
          filePath: "skills/my-skill/SKILL.md",
        });
        expect(result.riskLevel).toBe("high");
        expect(result.reason).toBe("Writes to skill source code");
      } finally {
        skillSourcePaths.delete(skillPath);
      }
    });

    test("hooks directory itself is high", async () => {
      const result = await classifyInput({
        toolName: "file_write",
        filePath: MOCK_HOOKS_DIR,
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to hooks directory");
    });

    test("file inside hooks directory is high", async () => {
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
      const result = await classifyInput({
        toolName: "file_write",
        filePath: "/tmp/output.txt",
        workingDir: "/",
      });
      expect(result.riskLevel).toBe("low");
    });
  });

  // ── file_edit ────────────────────────────────────────────────────────────

  describe("file_edit", () => {
    test("default risk is low", async () => {
      const result = await classifyInput({
        toolName: "file_edit",
        filePath: "src/index.ts",
      });
      expect(result.riskLevel).toBe("low");
      expect(result.reason).toBe("File edit (default)");
    });

    test("skill source path is high", async () => {
      const skillPath = resolve(WORKING_DIR, "skills/my-skill/index.ts");
      skillSourcePaths.add(skillPath);
      try {
        const result = await classifyInput({
          toolName: "file_edit",
          filePath: "skills/my-skill/index.ts",
        });
        expect(result.riskLevel).toBe("high");
        expect(result.reason).toBe("Writes to skill source code");
      } finally {
        skillSourcePaths.delete(skillPath);
      }
    });

    test("hooks directory path is high", async () => {
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

  // ── host_file_read ───────────────────────────────────────────────────────

  describe("host_file_read", () => {
    test("always medium (tool registry default)", async () => {
      const result = await classifyInput({
        toolName: "host_file_read",
        filePath: "/etc/passwd",
      });
      expect(result.riskLevel).toBe("medium");
      expect(result.reason).toBe("Host file read (default)");
      expect(result.matchType).toBe("registry");
    });

    test("medium even for empty path", async () => {
      const result = await classifyInput({
        toolName: "host_file_read",
        filePath: "",
      });
      expect(result.riskLevel).toBe("medium");
    });

    test("medium even for actor token signing key path", async () => {
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

  // ── host_file_write ──────────────────────────────────────────────────────

  describe("host_file_write", () => {
    test("default risk is medium", async () => {
      const result = await classifyInput({
        toolName: "host_file_write",
        filePath: "/tmp/output.txt",
      });
      expect(result.riskLevel).toBe("medium");
      expect(result.reason).toBe("Host file write (default)");
      expect(result.matchType).toBe("registry");
    });

    test("empty filePath is medium", async () => {
      const result = await classifyInput({
        toolName: "host_file_write",
        filePath: "",
      });
      expect(result.riskLevel).toBe("medium");
    });

    test("skill source path is high", async () => {
      // Host tools resolve with resolve(filePath) — no workingDir prefix.
      const absSkillPath = "/home/user/skills/evil-skill/SKILL.md";
      skillSourcePaths.add(resolve(absSkillPath));
      try {
        const result = await classifyInput({
          toolName: "host_file_write",
          filePath: absSkillPath,
        });
        expect(result.riskLevel).toBe("high");
        expect(result.reason).toBe("Writes to skill source code");
      } finally {
        skillSourcePaths.delete(resolve(absSkillPath));
      }
    });

    test("hooks directory is high", async () => {
      const result = await classifyInput({
        toolName: "host_file_write",
        filePath: MOCK_HOOKS_DIR,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to hooks directory");
    });

    test("file inside hooks directory is high", async () => {
      const hookFile = join(MOCK_HOOKS_DIR, "pre-tool-use.sh");
      const result = await classifyInput({
        toolName: "host_file_write",
        filePath: hookFile,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to hooks directory");
    });
  });

  // ── host_file_edit ───────────────────────────────────────────────────────

  describe("host_file_edit", () => {
    test("default risk is medium", async () => {
      const result = await classifyInput({
        toolName: "host_file_edit",
        filePath: "/tmp/output.txt",
      });
      expect(result.riskLevel).toBe("medium");
      expect(result.reason).toBe("Host file edit (default)");
    });

    test("skill source path is high", async () => {
      const absSkillPath = "/home/user/skills/evil-skill/index.ts";
      skillSourcePaths.add(resolve(absSkillPath));
      try {
        const result = await classifyInput({
          toolName: "host_file_edit",
          filePath: absSkillPath,
        });
        expect(result.riskLevel).toBe("high");
        expect(result.reason).toBe("Writes to skill source code");
      } finally {
        skillSourcePaths.delete(resolve(absSkillPath));
      }
    });

    test("hooks directory path is high", async () => {
      const hookFile = join(MOCK_HOOKS_DIR, "post-tool-use.sh");
      const result = await classifyInput({
        toolName: "host_file_edit",
        filePath: hookFile,
      });
      expect(result.riskLevel).toBe("high");
      expect(result.reason).toBe("Writes to hooks directory");
    });
  });

  // ── Singleton export ─────────────────────────────────────────────────────

  describe("singleton", () => {
    test("fileRiskClassifier is an instance of FileRiskClassifier", () => {
      expect(fileRiskClassifier).toBeInstanceOf(FileRiskClassifier);
    });

    test("singleton produces same results as new instance", async () => {
      const singletonResult = await fileRiskClassifier.classify({
        toolName: "file_read",
        filePath: "src/index.ts",
        workingDir: WORKING_DIR,
      });
      const freshResult = await makeClassifier().classify({
        toolName: "file_read",
        filePath: "src/index.ts",
        workingDir: WORKING_DIR,
      });
      expect(singletonResult).toEqual(freshResult);
    });
  });

  // ── Path resolution behavior ─────────────────────────────────────────────

  describe("path resolution", () => {
    test("sandbox tools resolve paths relative to workingDir", async () => {
      // file_write with a relative skill path resolved against workingDir
      const relPath = "my-skills/test-skill/SKILL.md";
      const resolvedPath = resolve(WORKING_DIR, relPath);
      skillSourcePaths.add(resolvedPath);
      try {
        const result = await classifyInput({
          toolName: "file_write",
          filePath: relPath,
          workingDir: WORKING_DIR,
        });
        expect(result.riskLevel).toBe("high");
      } finally {
        skillSourcePaths.delete(resolvedPath);
      }
    });

    test("host tools resolve paths without workingDir", async () => {
      // host_file_write resolves with resolve(filePath) — workingDir is ignored.
      const absPath = "/absolute/skill-path/SKILL.md";
      skillSourcePaths.add(resolve(absPath));
      try {
        const result = await classifyInput({
          toolName: "host_file_write",
          filePath: absPath,
          // Even though workingDir is set, host tools ignore it
          workingDir: "/some/other/dir",
        });
        expect(result.riskLevel).toBe("high");
      } finally {
        skillSourcePaths.delete(resolve(absPath));
      }
    });
  });
});
