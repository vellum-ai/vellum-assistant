import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

import * as envRegistry from "../config/env-registry.js";
import {
  isControlPlaneWorkspaceWrite,
  isOutOfWorkspaceFileInvocation,
  isPathWithinWorkspaceRoot,
  isWorkspaceScopedInvocation,
} from "../permissions/workspace-policy.js";
import { BUNDLED_SYSTEM_SECTIONS } from "../prompts/templates/system-sections.js";

// ---------------------------------------------------------------------------
// Temp directory scaffold for symlink / path-containment tests
// ---------------------------------------------------------------------------

let testDir: string;
let workspaceRoot: string;
let outsideDir: string;
let symlinkInside: string;
let symlinkToOutside: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "ws-policy-test-"));
  workspaceRoot = join(testDir, "workspace");
  outsideDir = join(testDir, "outside");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(join(workspaceRoot, "src"), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  // Symlink inside workspace pointing to another directory inside workspace
  symlinkInside = join(workspaceRoot, "link-to-src");
  symlinkSync(join(workspaceRoot, "src"), symlinkInside);

  // Symlink inside workspace pointing outside the workspace
  symlinkToOutside = join(workspaceRoot, "link-to-outside");
  symlinkSync(outsideDir, symlinkToOutside);
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// isPathWithinWorkspaceRoot
// ---------------------------------------------------------------------------

describe("isPathWithinWorkspaceRoot", () => {
  test("returns true for a file directly inside the workspace", () => {
    expect(
      isPathWithinWorkspaceRoot(join(workspaceRoot, "file.txt"), workspaceRoot),
    ).toBe(true);
  });

  test("returns true for a file in a subdirectory", () => {
    expect(
      isPathWithinWorkspaceRoot(
        join(workspaceRoot, "src", "index.ts"),
        workspaceRoot,
      ),
    ).toBe(true);
  });

  test("returns true for the workspace root itself", () => {
    expect(isPathWithinWorkspaceRoot(workspaceRoot, workspaceRoot)).toBe(true);
  });

  test("returns false for a path outside the workspace", () => {
    expect(isPathWithinWorkspaceRoot(outsideDir, workspaceRoot)).toBe(false);
  });

  test("returns false for parent traversal escaping the workspace", () => {
    const escapedPath = join(workspaceRoot, "..", "outside", "secret.txt");
    expect(isPathWithinWorkspaceRoot(escapedPath, workspaceRoot)).toBe(false);
  });

  test("returns true for a symlink that resolves inside the workspace", () => {
    expect(isPathWithinWorkspaceRoot(symlinkInside, workspaceRoot)).toBe(true);
  });

  test("returns false for a symlink that resolves outside the workspace", () => {
    expect(isPathWithinWorkspaceRoot(symlinkToOutside, workspaceRoot)).toBe(
      false,
    );
  });

  test("returns false for empty filePath", () => {
    expect(isPathWithinWorkspaceRoot("", workspaceRoot)).toBe(false);
  });

  test("returns false for empty workspaceRoot", () => {
    expect(isPathWithinWorkspaceRoot("/some/file", "")).toBe(false);
  });

  test("returns false for both empty", () => {
    expect(isPathWithinWorkspaceRoot("", "")).toBe(false);
  });

  test("handles non-existent file paths gracefully (new file write)", () => {
    const newFile = join(workspaceRoot, "new-dir", "new-file.ts");
    expect(isPathWithinWorkspaceRoot(newFile, workspaceRoot)).toBe(true);
  });

  test("rejects path that is a prefix but not a child directory", () => {
    // e.g. /tmp/workspace-extra should NOT match /tmp/workspace
    const sibling = `${workspaceRoot}-extra`;
    mkdirSync(sibling, { recursive: true });
    expect(
      isPathWithinWorkspaceRoot(join(sibling, "file.txt"), workspaceRoot),
    ).toBe(false);
    rmSync(sibling, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// isWorkspaceScopedInvocation
// ---------------------------------------------------------------------------

describe("isWorkspaceScopedInvocation", () => {
  // ── Path-scoped tools ──────────────────────────────────────────────

  describe("file_read / file_write / file_edit", () => {
    test("returns true when file_path is inside workspace", () => {
      expect(
        isWorkspaceScopedInvocation(
          "file_read",
          { file_path: join(workspaceRoot, "foo.txt") },
          workspaceRoot,
        ),
      ).toBe(true);
    });

    test("returns true when path (alternate key) is inside workspace", () => {
      expect(
        isWorkspaceScopedInvocation(
          "file_write",
          { path: join(workspaceRoot, "bar.ts") },
          workspaceRoot,
        ),
      ).toBe(true);
    });

    test("returns false when file_path is outside workspace", () => {
      expect(
        isWorkspaceScopedInvocation(
          "file_edit",
          { file_path: "/etc/passwd" },
          workspaceRoot,
        ),
      ).toBe(false);
    });

    test("returns false when file_path is missing", () => {
      expect(isWorkspaceScopedInvocation("file_read", {}, workspaceRoot)).toBe(
        false,
      );
    });

    test("returns false when file_path is not a string", () => {
      expect(
        isWorkspaceScopedInvocation(
          "file_write",
          { file_path: 123 },
          workspaceRoot,
        ),
      ).toBe(false);
    });

    test("resolves relative path inside workspace against workspaceRoot", () => {
      expect(
        isWorkspaceScopedInvocation(
          "file_read",
          { path: "src/index.ts" },
          workspaceRoot,
        ),
      ).toBe(true);
    });

    test("resolves relative path with ../ that escapes workspace as outside", () => {
      expect(
        isWorkspaceScopedInvocation(
          "file_read",
          { file_path: "../outside/secret.txt" },
          workspaceRoot,
        ),
      ).toBe(false);
    });

    test("absolute path inside workspace still works", () => {
      expect(
        isWorkspaceScopedInvocation(
          "file_edit",
          { file_path: join(workspaceRoot, "src", "main.ts") },
          workspaceRoot,
        ),
      ).toBe(true);
    });

    test("keys on `path` (the executed field) when both fields are present", () => {
      expect(
        isWorkspaceScopedInvocation(
          "file_write",
          { path: "/etc/passwd", file_path: join(workspaceRoot, "x.txt") },
          workspaceRoot,
        ),
      ).toBe(false);
    });

    test("treats container-style /workspace paths as workspace-scoped", () => {
      expect(
        isWorkspaceScopedInvocation(
          "file_read",
          { path: "/workspace/src/index.ts" },
          workspaceRoot,
        ),
      ).toBe(true);
    });
  });

  // ── Bash ───────────────────────────────────────────────────────────

  describe("bash", () => {
    test("returns false when not containerized", () => {
      expect(
        isWorkspaceScopedInvocation(
          "bash",
          { command: "ls -la" },
          workspaceRoot,
        ),
      ).toBe(false);
    });

    test("returns true when containerized", () => {
      const spy = spyOn(envRegistry, "getIsContainerized").mockReturnValue(
        true,
      );
      try {
        expect(
          isWorkspaceScopedInvocation(
            "bash",
            { command: "ls -la" },
            workspaceRoot,
          ),
        ).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ── Network tools ──────────────────────────────────────────────────

  describe("network tools", () => {
    const networkTools = ["web_search", "web_fetch", "network_request"];

    for (const tool of networkTools) {
      test(`${tool} is NOT workspace-scoped`, () => {
        expect(isWorkspaceScopedInvocation(tool, {}, workspaceRoot)).toBe(
          false,
        );
      });
    }
  });

  // ── Host tools ─────────────────────────────────────────────────────

  describe("host tools", () => {
    const hostTools = [
      "host_file_read",
      "host_file_write",
      "host_file_edit",
      "host_bash",
    ];

    for (const tool of hostTools) {
      test(`${tool} is NOT workspace-scoped`, () => {
        expect(isWorkspaceScopedInvocation(tool, {}, workspaceRoot)).toBe(
          false,
        );
      });
    }
  });

  // ── Always-scoped safe tools ───────────────────────────────────────

  describe("always-scoped tools", () => {
    const safeTools = ["skill_load", "recall", "ui_update", "ui_dismiss"];

    for (const tool of safeTools) {
      test(`${tool} is workspace-scoped`, () => {
        expect(isWorkspaceScopedInvocation(tool, {}, workspaceRoot)).toBe(true);
      });
    }
  });

  // ── Unknown tools ──────────────────────────────────────────────────

  describe("unknown tools", () => {
    test("defaults to NOT workspace-scoped", () => {
      expect(
        isWorkspaceScopedInvocation("mystery_tool", {}, workspaceRoot),
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// isOutOfWorkspaceFileInvocation
// ---------------------------------------------------------------------------

describe("isOutOfWorkspaceFileInvocation", () => {
  test("returns true for a file tool targeting an outside path", () => {
    expect(
      isOutOfWorkspaceFileInvocation(
        "file_read",
        { path: join(outsideDir, "notes.txt") },
        workspaceRoot,
      ),
    ).toBe(true);
  });

  test("returns true for an in-workspace symlink that resolves outside", () => {
    expect(
      isOutOfWorkspaceFileInvocation(
        "file_write",
        { path: symlinkToOutside },
        workspaceRoot,
      ),
    ).toBe(true);
  });

  test("returns true for an in-workspace DANGLING symlink whose destination is outside", () => {
    // The destination does not exist — a write through the link creates it
    // outside the workspace, so containment must see the destination.
    const dangling = join(workspaceRoot, "dangling-out");
    symlinkSync(join(outsideDir, "not-yet.txt"), dangling);
    try {
      expect(
        isOutOfWorkspaceFileInvocation(
          "file_write",
          { path: dangling },
          workspaceRoot,
        ),
      ).toBe(true);
      expect(isPathWithinWorkspaceRoot(dangling, workspaceRoot)).toBe(false);
    } finally {
      rmSync(dangling, { force: true });
    }
  });

  test("returns false for an in-workspace relative path", () => {
    expect(
      isOutOfWorkspaceFileInvocation(
        "file_write",
        { path: "src/index.ts" },
        workspaceRoot,
      ),
    ).toBe(false);
  });

  test("keys on `path` when both `path` and `file_path` are present", () => {
    // `path` is the field the file tools execute; an input carrying both
    // must not dodge the containment check via a benign `file_path`.
    expect(
      isOutOfWorkspaceFileInvocation(
        "file_read",
        { path: join(outsideDir, "notes.txt"), file_path: "src/index.ts" },
        workspaceRoot,
      ),
    ).toBe(true);
    expect(
      isOutOfWorkspaceFileInvocation(
        "file_read",
        { path: "src/index.ts", file_path: join(outsideDir, "notes.txt") },
        workspaceRoot,
      ),
    ).toBe(false);
  });

  test("remaps container-style /workspace paths before the containment check", () => {
    expect(
      isOutOfWorkspaceFileInvocation(
        "file_read",
        { path: "/workspace/src/index.ts" },
        workspaceRoot,
      ),
    ).toBe(false);
  });

  test("returns false for non-path tools", () => {
    expect(
      isOutOfWorkspaceFileInvocation(
        "bash",
        { command: "cat /etc/hosts" },
        workspaceRoot,
      ),
    ).toBe(false);
  });

  test("returns false when the input carries no path", () => {
    expect(isOutOfWorkspaceFileInvocation("file_read", {}, workspaceRoot)).toBe(
      false,
    );
  });

  test("returns false when containerized", () => {
    const spy = spyOn(envRegistry, "getIsContainerized").mockReturnValue(true);
    try {
      expect(
        isOutOfWorkspaceFileInvocation(
          "file_read",
          { path: join(outsideDir, "notes.txt") },
          workspaceRoot,
        ),
      ).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// isExecutableWorkspaceWrite
// ---------------------------------------------------------------------------

// The sink directories come from the workspace getters (getWorkspaceHooksDir
// et al.), which resolve against the configured workspace — so these tests run
// against the per-process workspace override, not this file's scaffold root.
// Using the scaffold would let the probe root and the getters diverge, and the
// tests would pass without exercising the real comparison.
describe("isControlPlaneWorkspaceWrite / executable sinks", () => {
  const wsRoot = process.env.VELLUM_WORKSPACE_DIR!;

  beforeAll(() => {
    mkdirSync(join(wsRoot, "hooks"), { recursive: true });
    mkdirSync(join(wsRoot, "notes-real"), { recursive: true });
    // A benign-looking symlink inside the workspace pointing at hooks/.
    symlinkSync(join(wsRoot, "hooks"), join(wsRoot, "notes-link"));
  });

  afterAll(() => {
    rmSync(join(wsRoot, "notes-link"), { force: true });
  });

  test.each([
    ["relative", "hooks/evil.ts"],
    ["absolute", () => join(wsRoot, "hooks", "evil.ts")],
    ["container /workspace form", "/workspace/hooks/evil.ts"],
    ["dot-dot traversal", "notes-real/../hooks/evil.ts"],
  ])("blocks a write into hooks/ via %s path", (_label, path) => {
    const resolved = typeof path === "function" ? path() : path;
    expect(
      isControlPlaneWorkspaceWrite("file_write", { path: resolved }, wsRoot),
    ).toBe(true);
  });

  // The path is lexically ordinary; only canonicalization sees where it lands.
  // The sibling predicates above canonicalize for exactly this reason.
  test("blocks a write through a symlink into hooks/", () => {
    expect(
      isControlPlaneWorkspaceWrite(
        "file_write",
        { path: "notes-link/evil.ts" },
        wsRoot,
      ),
    ).toBe(true);
  });

  // A write through a link that will land inside a sink dir once created.
  test("blocks a write through a DANGLING symlink into hooks/", () => {
    const dangling = join(wsRoot, "dangling-into-hooks");
    symlinkSync(join(wsRoot, "hooks", "not-yet.ts"), dangling);
    try {
      expect(
        isControlPlaneWorkspaceWrite("file_write", { path: dangling }, wsRoot),
      ).toBe(true);
    } finally {
      rmSync(dangling, { force: true });
    }
  });

  // The sentinel under data/monitoring steers which plugin code the daemon
  // imports — the classifier gates it as a code-injection sink, so the
  // channel floor must too.
  test("blocks a write into the monitoring data directory", () => {
    expect(
      isControlPlaneWorkspaceWrite(
        "file_write",
        { path: "data/monitoring/source-versions.json" },
        wsRoot,
      ),
    ).toBe(true);
  });

  test("ordinary workspace writes and reads stay clear", () => {
    expect(
      isControlPlaneWorkspaceWrite(
        "file_write",
        { path: "notes-real/todo.md" },
        wsRoot,
      ),
    ).toBe(false);
    // Reads never plant code, even into a sink dir.
    expect(
      isControlPlaneWorkspaceWrite(
        "file_read",
        { path: "hooks/on-message.ts" },
        wsRoot,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPromptSurfaceWrite
// ---------------------------------------------------------------------------

describe("isControlPlaneWorkspaceWrite / prompt surfaces", () => {
  const wsRoot = process.env.VELLUM_WORKSPACE_DIR!;

  test.each([
    "IDENTITY.md",
    "SOUL.md",
    "VOICE.md",
    "BOOTSTRAP.md",
    "users/alice.md",
    "users/default.md",
    "channels/general.md",
    "HEARTBEAT.md",
    "NOW.md",
  ])("blocks a write to %s", (path) => {
    expect(isControlPlaneWorkspaceWrite("file_write", { path }, wsRoot)).toBe(
      true,
    );
  });

  // The section override layer: any `<section-id>.md` under prompts/system/
  // replaces the bundled section of the same id — or, stripped to nothing,
  // silences it — including the security-policy sections. A brand-new id
  // adds a workspace-only section, so the whole directory is a prompt
  // surface, not just the bundled ids.
  test.each([
    ["a security-section override", "prompts/system/06-credential-security.md"],
    [
      "the non-guardian boundary override",
      "prompts/system/10a-non-guardian-boundary.md",
    ],
    ["a workspace-only addition", "prompts/system/99-injected-section.md"],
    [
      "the container /workspace form",
      "/workspace/prompts/system/07-external-content.md",
    ],
  ])("blocks %s — %s", (_label, path) => {
    expect(isControlPlaneWorkspaceWrite("file_write", { path }, wsRoot)).toBe(
      true,
    );
    expect(isControlPlaneWorkspaceWrite("file_edit", { path }, wsRoot)).toBe(
      true,
    );
  });

  // The reverse symlink dodge: the control-plane *name* is itself a link to
  // a benign path. The write's bytes land at the destination, but the
  // renderer and the loaders open the control-plane name and follow the
  // link — so the addressed name must match the baselines even though the
  // canonical destination does not.
  test.each([
    ["a section override", "prompts/system/06-credential-security.md"],
    ["an executable sink entry", "hooks/on-boot.ts"],
    ["a per-user context file", "users/someone.md"],
  ])(
    "blocks a write addressed at %s that is a symlink to a benign path",
    (_label, addressedPath) => {
      const parentDir = join(wsRoot, dirname(addressedPath));
      const parentExisted = existsSync(parentDir);
      mkdirSync(parentDir, { recursive: true });
      const destination = join(wsRoot, "notes-real", "decoy.txt");
      symlinkSync(destination, join(wsRoot, addressedPath));
      try {
        expect(
          isControlPlaneWorkspaceWrite(
            "file_write",
            { path: addressedPath },
            wsRoot,
          ),
        ).toBe(true);
      } finally {
        rmSync(join(wsRoot, addressedPath), { force: true });
        if (!parentExisted) {
          rmSync(parentDir, { recursive: true, force: true });
        }
      }
    },
  );

  // Drift guard: the override path for every bundled section id must be
  // covered, so adding a section cannot silently open a writable override
  // for it.
  test("covers the override path of every bundled system section", () => {
    expect(BUNDLED_SYSTEM_SECTIONS.length).toBeGreaterThan(0);
    for (const section of BUNDLED_SYSTEM_SECTIONS) {
      expect(
        isControlPlaneWorkspaceWrite(
          "file_write",
          { path: `prompts/system/${section.id}.md` },
          wsRoot,
        ),
      ).toBe(true);
    }
  });

  // A surface that is itself a symlink is read through the link by the
  // renderer, so a write to either name rewrites the prompt — the baselines
  // canonicalize like the targets do.
  test("blocks both names when the surface itself is a symlink", () => {
    mkdirSync(join(wsRoot, "personas"), { recursive: true });
    symlinkSync(
      join(wsRoot, "personas", "current.md"),
      join(wsRoot, "SOUL.md"),
    );
    try {
      // Addressed through the link: the target canonicalizes past it.
      expect(
        isControlPlaneWorkspaceWrite("file_write", { path: "SOUL.md" }, wsRoot),
      ).toBe(true);
      // Addressed at the link's destination directly.
      expect(
        isControlPlaneWorkspaceWrite(
          "file_write",
          { path: "personas/current.md" },
          wsRoot,
        ),
      ).toBe(true);
      // A sibling in the same directory is still an ordinary write.
      expect(
        isControlPlaneWorkspaceWrite(
          "file_write",
          { path: "personas/other.md" },
          wsRoot,
        ),
      ).toBe(false);
    } finally {
      rmSync(join(wsRoot, "SOUL.md"), { force: true });
      rmSync(join(wsRoot, "personas"), { recursive: true, force: true });
    }
  });

  // Same shape for a surface directory: users/ itself is a symlink to
  // another in-workspace directory, and the renderer reads through it — so a
  // write under either name rewrites per-user context.
  test("blocks both names when a surface directory is a symlink", () => {
    mkdirSync(join(wsRoot, "people-real"), { recursive: true });
    symlinkSync(join(wsRoot, "people-real"), join(wsRoot, "users"));
    try {
      // Addressed through the linked surface name.
      expect(
        isControlPlaneWorkspaceWrite(
          "file_write",
          { path: "users/someone.md" },
          wsRoot,
        ),
      ).toBe(true);
      // Addressed at the link's destination directly.
      expect(
        isControlPlaneWorkspaceWrite(
          "file_write",
          { path: "people-real/someone.md" },
          wsRoot,
        ),
      ).toBe(true);
    } finally {
      rmSync(join(wsRoot, "users"), { force: true });
      rmSync(join(wsRoot, "people-real"), { recursive: true, force: true });
    }
  });

  // The path is lexically ordinary; only canonicalization sees where it
  // lands — same symlink dodge as the executable sinks.
  test("blocks a write through a symlink onto a prompt surface", () => {
    symlinkSync(join(wsRoot, "SOUL.md"), join(wsRoot, "innocent-notes.md"));
    try {
      expect(
        isControlPlaneWorkspaceWrite(
          "file_write",
          { path: "innocent-notes.md" },
          wsRoot,
        ),
      ).toBe(true);
    } finally {
      rmSync(join(wsRoot, "innocent-notes.md"), { force: true });
    }
  });

  test("blocks the container /workspace form and dot-dot traversal", () => {
    expect(
      isControlPlaneWorkspaceWrite(
        "file_write",
        { path: "/workspace/SOUL.md" },
        wsRoot,
      ),
    ).toBe(true);
    expect(
      isControlPlaneWorkspaceWrite(
        "file_write",
        { path: "notes-real/../SOUL.md" },
        wsRoot,
      ),
    ).toBe(true);
  });

  test("ordinary writes and reads stay clear", () => {
    expect(
      isControlPlaneWorkspaceWrite(
        "file_write",
        { path: "notes-real/todo.md" },
        wsRoot,
      ),
    ).toBe(false);
    // A file merely named like a surface, in a subdirectory, is not one.
    expect(
      isControlPlaneWorkspaceWrite(
        "file_write",
        { path: "notes-real/SOUL.md" },
        wsRoot,
      ),
    ).toBe(false);
    expect(
      isControlPlaneWorkspaceWrite("file_read", { path: "SOUL.md" }, wsRoot),
    ).toBe(false);
  });

  // Drift guard: every workspace path the prompt renderer reads must be
  // covered by the predicate, so adding a section cannot silently open a
  // writable prompt surface.
  test("covers every workspacePath the system sections declare", () => {
    const paths = BUNDLED_SYSTEM_SECTIONS.flatMap((section) => {
      const wp = (section as { workspacePath?: string | string[] })
        .workspacePath;
      if (!wp) {
        return [];
      }
      return Array.isArray(wp) ? wp : [wp];
    }).map((path) =>
      path
        .replace("{{userSlug}}", "someone")
        .replace("{{channelSlug}}", "general"),
    );

    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(isControlPlaneWorkspaceWrite("file_write", { path }, wsRoot)).toBe(
        true,
      );
    }
  });
});
