import { describe, expect, test } from "bun:test";

import {
  PROMPT_SURFACE_DIRS,
  PROMPT_SURFACE_FILES,
} from "../permissions/workspace-policy.js";
import {
  commandDeletesProtectedWorkspaceFile,
  enforceProtectedWorkspaceDeletePolicy,
  isProtectedFromDeleteRelPath,
  PROTECTED_FROM_DELETE_DIRS,
  PROTECTED_FROM_DELETE_FILES,
} from "./protected-workspace-delete-policy.js";

const WS = "/workspace";

function deniedTarget(command: string): string | null {
  const result = commandDeletesProtectedWorkspaceFile(command, WS);
  return result.denied ? result.target : null;
}

describe("allowlist coverage", () => {
  test("includes every prompt-surface file and directory", () => {
    for (const file of PROMPT_SURFACE_FILES) {
      expect(PROTECTED_FROM_DELETE_FILES).toContain(file);
    }
    for (const dir of PROMPT_SURFACE_DIRS) {
      expect(PROTECTED_FROM_DELETE_DIRS).toContain(dir);
    }
    expect(PROTECTED_FROM_DELETE_FILES).toContain("config.json");
  });
});

describe("isProtectedFromDeleteRelPath", () => {
  test("covers config and prompt-surface files", () => {
    expect(isProtectedFromDeleteRelPath("config.json")).toBe(true);
    expect(isProtectedFromDeleteRelPath("SOUL.md")).toBe(true);
    expect(isProtectedFromDeleteRelPath("IDENTITY.md")).toBe(true);
    expect(isProtectedFromDeleteRelPath("users/alice.md")).toBe(true);
    expect(isProtectedFromDeleteRelPath("channels/general.md")).toBe(true);
    expect(isProtectedFromDeleteRelPath("ui/theme.json")).toBe(true);
  });

  test("does not cover ordinary workspace files", () => {
    expect(isProtectedFromDeleteRelPath("scratch/notes.md")).toBe(false);
    expect(isProtectedFromDeleteRelPath("data/home-feed.json")).toBe(false);
    expect(isProtectedFromDeleteRelPath("journal/2026-08-24.md")).toBe(false);
  });
});

describe("commandDeletesProtectedWorkspaceFile", () => {
  test("allows deletes outside the allowlist", () => {
    expect(deniedTarget("rm scratch/notes.md")).toBeNull();
    expect(deniedTarget("rm -rf scratch/agentboard")).toBeNull();
    expect(deniedTarget("rm /tmp/config.json")).toBeNull();
    expect(deniedTarget("rm data/credentials/metadata.json")).toBeNull();
    expect(deniedTarget("ls config.json")).toBeNull();
    expect(deniedTarget("cat SOUL.md && rm scratch/foo")).toBeNull();
  });

  test("blocks rm of config.json in the usual spellings", () => {
    expect(deniedTarget("rm config.json")).toBe("config.json");
    expect(deniedTarget("rm -f config.json")).toBe("config.json");
    expect(deniedTarget("rm ./config.json")).toBe("config.json");
    expect(deniedTarget("rm /workspace/config.json")).toBe("config.json");
    expect(deniedTarget("rm -- config.json")).toBe("config.json");
  });

  test("blocks rm of prompt-surface files", () => {
    expect(deniedTarget("rm SOUL.md")).toBe("SOUL.md");
    expect(deniedTarget("rm IDENTITY.md HEARTBEAT.md")).toBe("IDENTITY.md");
    expect(deniedTarget("rm users/default.md")).toBe("users/default.md");
    expect(deniedTarget("rm -rf users")).toBe("users");
  });

  test("blocks wrappers around rm", () => {
    expect(deniedTarget("sudo rm config.json")).toBe("config.json");
    expect(deniedTarget("command rm -f SOUL.md")).toBe("SOUL.md");
    expect(deniedTarget("env FOO=1 rm NOW.md")).toBe("NOW.md");
    expect(deniedTarget("timeout 10 rm config.json")).toBe("config.json");
  });

  test("blocks unlink, git rm, and mv-away", () => {
    expect(deniedTarget("unlink config.json")).toBe("config.json");
    expect(deniedTarget("git rm SOUL.md")).toBe("SOUL.md");
    expect(deniedTarget("mv config.json /tmp/config.json.bak")).toBe(
      "config.json",
    );
  });

  test("allows git rm --cached (index only)", () => {
    expect(deniedTarget("git rm --cached config.json")).toBeNull();
  });

  test("blocks workspace-root wipes", () => {
    expect(deniedTarget("rm -rf .")).not.toBeNull();
    expect(deniedTarget("rm -rf /workspace")).not.toBeNull();
    expect(deniedTarget("rm -rf /workspace/")).not.toBeNull();
    expect(deniedTarget("rm -rf *")).not.toBeNull();
    expect(deniedTarget("rm *")).not.toBeNull();
  });

  test("does not treat filesystem root as the workspace", () => {
    expect(deniedTarget("rm -rf /")).toBeNull();
  });

  test("blocks find -delete of the workspace root", () => {
    expect(deniedTarget("find . -name '*.md' -delete")).not.toBeNull();
    expect(deniedTarget("find /workspace -delete")).not.toBeNull();
  });

  test("allows find -delete under scratch", () => {
    expect(deniedTarget("find scratch -name '*.tmp' -delete")).toBeNull();
  });

  test("inspects every segment of a compound command", () => {
    expect(deniedTarget("ls && rm config.json")).toBe("config.json");
    expect(deniedTarget("rm scratch/a && rm SOUL.md")).toBe("SOUL.md");
  });
});

describe("enforceProtectedWorkspaceDeletePolicy", () => {
  test("ignores non-shell tools", () => {
    const result = enforceProtectedWorkspaceDeletePolicy(
      "file_write",
      { path: "config.json", content: "{}" },
      WS,
    );
    expect(result.denied).toBe(false);
  });

  test("blocks bash and host_bash", () => {
    const bash = enforceProtectedWorkspaceDeletePolicy(
      "bash",
      { command: "rm config.json" },
      WS,
    );
    const host = enforceProtectedWorkspaceDeletePolicy(
      "host_bash",
      { command: "rm /workspace/SOUL.md" },
      WS,
    );
    expect(bash.denied).toBe(true);
    expect(host.denied).toBe(true);
    if (bash.denied) {
      expect(bash.reason).toContain("config.json");
    }
  });

  test("tells the model how to proceed", () => {
    const result = enforceProtectedWorkspaceDeletePolicy(
      "bash",
      { command: "rm -rf /workspace" },
      WS,
    );
    expect(result.denied).toBe(true);
    if (result.denied) {
      expect(result.reason).toContain("workspace root");
      expect(result.reason).not.toContain("daemon");
    }
  });
});
