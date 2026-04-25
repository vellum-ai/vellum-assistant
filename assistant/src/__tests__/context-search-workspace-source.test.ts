import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import type { AssistantConfig } from "../config/schema.js";
import {
  inspectWorkspacePaths,
  searchWorkspaceSource,
  WORKSPACE_SOURCE_MAX_FILE_SIZE_BYTES,
  WORKSPACE_SOURCE_MAX_SCANNED_FILES,
} from "../memory/context-search/sources/workspace.js";
import type { RecallSearchContext } from "../memory/context-search/types.js";

const testDirs: string[] = [];

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "context-search-workspace-source-")),
  );
  testDirs.push(dir);
  return dir;
}

function makeContext(workingDir: string): RecallSearchContext {
  return {
    workingDir,
    memoryScopeId: "scope-123",
    conversationId: "conversation-123",
    config: {} as AssistantConfig,
  };
}

function writeWorkspaceFile(root: string, relativePath: string, text: string) {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, text);
}

describe("searchWorkspaceSource", () => {
  test("returns lexical excerpts scored by query term overlap", async () => {
    const root = makeTempDir();
    writeWorkspaceFile(
      root,
      "notes/project.md",
      [
        "intro line",
        "alpha release planning",
        "alpha beta launch checklist",
        "closing line",
      ].join("\n"),
    );
    writeWorkspaceFile(root, "notes/other.md", "alpha only");

    const result = await searchWorkspaceSource(
      "alpha beta",
      makeContext(root),
      10,
    );

    expect(result.evidence).toHaveLength(2);
    expect(result.evidence[0]).toMatchObject({
      source: "workspace",
      title: "notes/project.md",
      locator: "notes/project.md:3",
    });
    expect(result.evidence[0].excerpt).toBe(
      "2: alpha release planning\n3: alpha beta launch checklist\n4: closing line",
    );
    expect(result.evidence[0].score).toBeGreaterThan(
      result.evidence[1].score ?? 0,
    );
    expect(result.evidence[0].metadata).toMatchObject({
      path: "notes/project.md",
      lineNumber: 3,
      matchedTerms: ["alpha", "beta"],
    });
  });

  test("rejects symlink entries that resolve outside the workspace root", async () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    writeWorkspaceFile(outside, "outside.md", "needle outside secret");
    symlinkSync(join(outside, "outside.md"), join(root, "linked.md"));
    writeWorkspaceFile(root, "inside.md", "needle inside safe");

    const result = await searchWorkspaceSource("needle", makeContext(root), 10);

    expect(result.evidence.map((item) => item.locator)).toEqual([
      "inside.md:1",
    ]);
  });

  test("allows safe hidden paths while skipping generated, dependency, and secret-shaped paths", async () => {
    const root = makeTempDir();
    writeWorkspaceFile(root, ".hidden.md", "needle hidden");
    writeWorkspaceFile(
      root,
      ".birthday-builds/.format-rec.md",
      "needle safe hidden file",
    );
    writeWorkspaceFile(root, ".birthday-builds/cake.md", "needle safe hidden");
    writeWorkspaceFile(root, ".git/config.md", "needle git");
    writeWorkspaceFile(root, ".private/notes.md", "needle private");
    writeWorkspaceFile(root, "node_modules/pkg/index.md", "needle dependency");
    writeWorkspaceFile(root, "dist/output.md", "needle dist");
    writeWorkspaceFile(root, "build/output.md", "needle build");
    writeWorkspaceFile(root, ".cache/output.md", "needle cache");
    writeWorkspaceFile(root, ".turbo/output.md", "needle turbo");
    writeWorkspaceFile(root, ".next/output.md", "needle next");
    writeWorkspaceFile(root, "coverage/output.md", "needle coverage");
    writeWorkspaceFile(root, "target/output.md", "needle target");
    writeWorkspaceFile(root, ".env.local", "needle env");
    writeWorkspaceFile(root, "api-key.md", "needle key");
    writeWorkspaceFile(root, "secret-plan.md", "needle secret");
    writeWorkspaceFile(root, "token-cache.md", "needle token");
    writeWorkspaceFile(root, "credentials.json", "needle credentials");
    writeWorkspaceFile(root, "protected/readme.md", "needle protected");
    writeWorkspaceFile(root, "gateway-security/readme.md", "needle gateway");
    writeWorkspaceFile(root, "ces-security/readme.md", "needle ces");
    writeWorkspaceFile(root, "src/readme.md", "needle safe");

    const result = await searchWorkspaceSource("needle", makeContext(root), 10);

    expect(result.evidence.map((item) => item.locator)).toEqual([
      ".birthday-builds/.format-rec.md:1",
      ".birthday-builds/cake.md:1",
      ".hidden.md:1",
      "src/readme.md:1",
    ]);
  });

  test("prioritizes live user-authored directories before noisy archives", async () => {
    const root = makeTempDir();
    for (
      let index = 0;
      index < WORKSPACE_SOURCE_MAX_SCANNED_FILES;
      index += 1
    ) {
      writeWorkspaceFile(
        root,
        `backups/${String(index).padStart(3, "0")}.md`,
        "archive-only marker",
      );
    }
    writeWorkspaceFile(root, "journal/today.md", "journalneedle fresh fact");

    const result = await searchWorkspaceSource(
      "journalneedle",
      makeContext(root),
      10,
    );

    expect(result.evidence.map((item) => item.locator)).toEqual([
      "journal/today.md:1",
    ]);
  });

  test("gives each traversal bucket enough budget for later authored truth", async () => {
    const root = makeTempDir();
    for (
      let index = 0;
      index < WORKSPACE_SOURCE_MAX_SCANNED_FILES;
      index += 1
    ) {
      writeWorkspaceFile(
        root,
        `scratch/${String(index).padStart(3, "0")}.md`,
        "sharedneedle scratch filler",
      );
    }
    writeWorkspaceFile(
      root,
      ".birthday-builds/format.md",
      "formatneedle hidden authored decision",
    );
    writeWorkspaceFile(root, "work/source.md", "workneedle live authored doc");
    writeWorkspaceFile(
      root,
      "data/apps/example-app.json",
      JSON.stringify({
        name: "Example App",
        description: "appneedle current app metadata",
        dirName: "example-app",
      }),
    );

    const result = await searchWorkspaceSource(
      "sharedneedle formatneedle workneedle appneedle",
      makeContext(root),
      10,
    );

    expect(result.evidence.map((item) => item.title)).toEqual(
      expect.arrayContaining([
        ".birthday-builds/format.md",
        "work/source.md",
        "data/apps/example-app.json",
      ]),
    );
  });

  test("skips nested repo checkouts under scratch", async () => {
    const root = makeTempDir();
    writeWorkspaceFile(
      root,
      "scratch/vellum-assistant/notes.md",
      "deepneedle generated checkout",
    );
    writeWorkspaceFile(root, "work/notes.md", "deepneedle live authored note");

    const result = await searchWorkspaceSource(
      "deepneedle",
      makeContext(root),
      10,
    );

    expect(result.evidence.map((item) => item.title)).toEqual([
      "work/notes.md",
    ]);
  });

  test("ranks live work documents above archive references", async () => {
    const root = makeTempDir();
    writeWorkspaceFile(
      root,
      "backups/archive.md",
      "launch architecture decision exists in a separate work document",
    );
    writeWorkspaceFile(
      root,
      "work/decision.md",
      "launch architecture decision: keep the local-first design",
    );

    const result = await searchWorkspaceSource(
      "launch architecture decision local-first",
      makeContext(root),
      10,
    );

    expect(result.evidence[0]?.title).toBe("work/decision.md");
    expect(result.evidence[0]?.excerpt).toContain("local-first design");
  });

  test("ranks current location tracker JSON above older PKB summaries", async () => {
    const root = makeTempDir();
    writeWorkspaceFile(
      root,
      "pkb/archive/location.md",
      "home current place metadata was summarized previously",
    );
    writeWorkspaceFile(
      root,
      "scratch/location-tracker/named_places.json",
      JSON.stringify({
        places: [
          {
            name: "Home",
            description: "current place metadata",
            lat: 12.34,
            lon: 56.78,
            radius_m: 90,
          },
        ],
      }),
    );

    const result = await searchWorkspaceSource(
      "home current place metadata",
      makeContext(root),
      10,
    );

    expect(result.evidence[0]).toMatchObject({
      title: "scratch/location-tracker/named_places.json",
      metadata: { retrieval: "structured-json" },
    });
    expect(result.evidence[0]?.excerpt).toContain('"radius_m": 90');
  });

  test("returns the matching markdown section with heading metadata", async () => {
    const root = makeTempDir();
    writeWorkspaceFile(
      root,
      "scratch/cases.md",
      [
        "# Case Notes",
        "A general index with voluntary mentions.",
        "",
        "## Voluntary Silence Case",
        "The remedy is to wait for an explicit opt-in before sending updates.",
        "The boundary applies to quiet periods and follow-up prompts.",
        "",
        "## Other Case",
        "This section should not be returned for the remedy query.",
      ].join("\n"),
    );

    const result = await searchWorkspaceSource(
      "voluntary silence case remedy boundary",
      makeContext(root),
      10,
    );

    expect(result.evidence[0]).toMatchObject({
      title: "scratch/cases.md",
      locator: "scratch/cases.md:4",
      metadata: {
        retrieval: "section",
        heading: "Voluntary Silence Case",
      },
    });
    expect(result.evidence[0]?.excerpt).toContain(
      "4: ## Voluntary Silence Case",
    );
    expect(result.evidence[0]?.excerpt).toContain(
      "wait for an explicit opt-in",
    );
  });

  test("returns compact structured JSON excerpts for app metadata", async () => {
    const root = makeTempDir();
    writeWorkspaceFile(
      root,
      "data/apps/example-app.json",
      JSON.stringify({
        name: "Example Apartment",
        description: "A small apartment inventory app with current metadata.",
        dirName: "example-apartment",
        nested: {
          name: "Nested Tool",
          description: "Nested fields should be compact.",
          veryLargeField: "x".repeat(2_000),
        },
      }),
    );

    const result = await searchWorkspaceSource(
      "apartment app current metadata",
      makeContext(root),
      10,
    );

    expect(result.evidence[0]).toMatchObject({
      title: "data/apps/example-app.json",
      locator: "data/apps/example-app.json:1",
      metadata: { retrieval: "structured-json" },
    });
    expect(result.evidence[0]?.excerpt).toContain(
      '"name": "Example Apartment"',
    );
    expect(result.evidence[0]?.excerpt).toContain(
      '"dirName": "example-apartment"',
    );
    expect(result.evidence[0]?.excerpt.length).toBeLessThanOrEqual(1_400);
  });

  test("returns exact safe path literals even when file text does not match", async () => {
    const root = makeTempDir();
    writeWorkspaceFile(
      root,
      "scratch/handoff.md",
      ["# Handoff", "Use the crimson folder for the next review."].join("\n"),
    );

    const result = await searchWorkspaceSource(
      "inspect scratch/handoff.md",
      makeContext(root),
      10,
    );

    expect(result.evidence[0]).toMatchObject({
      title: "scratch/handoff.md",
      locator: "scratch/handoff.md:1",
      metadata: { retrieval: "path", path: "scratch/handoff.md" },
    });
    expect(result.evidence[0]?.excerpt).toContain("crimson folder");
  });

  test("skips conversation metadata files in workspace search", async () => {
    const root = makeTempDir();
    writeWorkspaceFile(
      root,
      "conversations/conversation-123/meta.json",
      '{"title":"needle metadata title"}',
    );
    writeWorkspaceFile(root, "journal/note.md", "needle journal fact");

    const result = await searchWorkspaceSource("needle", makeContext(root), 10);

    expect(result.evidence.map((item) => item.locator)).toEqual([
      "journal/note.md:1",
    ]);
  });

  test("preserves the matched line when surrounding context is too long", async () => {
    const root = makeTempDir();
    writeWorkspaceFile(
      root,
      "notes/details.md",
      [`prefix ${"x".repeat(900)}`, "needle final detail", "tail"].join("\n"),
    );

    const result = await searchWorkspaceSource("needle", makeContext(root), 10);

    expect(result.evidence[0]?.excerpt).toBe("2: needle final detail");
  });

  test("reads only allowed text-like extensions", async () => {
    const root = makeTempDir();
    writeWorkspaceFile(root, "readme.md", "needle markdown");
    writeWorkspaceFile(root, "notes.txt", "needle text");
    writeWorkspaceFile(root, "config.json", "needle json");
    writeWorkspaceFile(root, "config.yaml", "needle yaml");
    writeWorkspaceFile(root, "config.yml", "needle yml");
    writeWorkspaceFile(root, "src/index.ts", "needle ts");
    writeWorkspaceFile(root, "src/view.tsx", "needle tsx");
    writeWorkspaceFile(root, "src/index.js", "needle js");
    writeWorkspaceFile(root, "src/view.jsx", "needle jsx");
    writeWorkspaceFile(root, "scripts/tool.py", "needle py");
    writeWorkspaceFile(root, "clients/App.swift", "needle swift");
    writeWorkspaceFile(root, "scripts/run.sh", "needle sh");
    writeWorkspaceFile(root, "settings.toml", "needle toml");
    writeWorkspaceFile(root, "page.html", "needle html");
    writeWorkspaceFile(root, "style.css", "needle css");
    writeWorkspaceFile(root, "schema.sql", "needle sql");
    writeWorkspaceFile(root, "image.png", "needle png");
    writeWorkspaceFile(root, "README", "needle extensionless");

    const result = await searchWorkspaceSource("needle", makeContext(root), 30);

    expect(result.evidence.map((item) => item.title).sort()).toEqual([
      "clients/App.swift",
      "config.json",
      "config.yaml",
      "config.yml",
      "notes.txt",
      "page.html",
      "readme.md",
      "schema.sql",
      "scripts/run.sh",
      "scripts/tool.py",
      "settings.toml",
      "src/index.js",
      "src/index.ts",
      "src/view.jsx",
      "src/view.tsx",
      "style.css",
    ]);
  });

  test("skips files larger than the workspace source size cap", async () => {
    const root = makeTempDir();
    writeWorkspaceFile(
      root,
      "large.md",
      `${"x".repeat(WORKSPACE_SOURCE_MAX_FILE_SIZE_BYTES)}\nneedle`,
    );
    writeWorkspaceFile(root, "small.md", "needle small");

    const result = await searchWorkspaceSource("needle", makeContext(root), 10);

    expect(result.evidence.map((item) => item.locator)).toEqual(["small.md:1"]);
  });

  test("caps scanned files and returned results", async () => {
    const root = makeTempDir();
    for (
      let index = 0;
      index < WORKSPACE_SOURCE_MAX_SCANNED_FILES;
      index += 1
    ) {
      writeWorkspaceFile(
        root,
        `docs/${String(index).padStart(3, "0")}.md`,
        "needle scanned",
      );
    }
    writeWorkspaceFile(root, "docs/999.md", "needle beyond cap");

    const result = await searchWorkspaceSource("needle", makeContext(root), 7);

    expect(result.evidence).toHaveLength(7);
    expect(result.evidence.map((item) => item.title)).not.toContain(
      "docs/999.md",
    );
  });

  test("returns an empty result for a non-directory workspace root", async () => {
    const root = makeTempDir();
    const filePath = join(root, "not-a-directory.md");
    writeFileSync(filePath, "needle");

    const result = await searchWorkspaceSource(
      "needle",
      makeContext(filePath),
      10,
    );

    expect(result.evidence).toEqual([]);
  });
});

describe("inspectWorkspacePaths", () => {
  test("inspects up to five safe surfaced files and reports unsafe paths", async () => {
    const root = makeTempDir();
    writeWorkspaceFile(root, "scratch/handoff.md", "handoff exact truth");
    writeWorkspaceFile(
      root,
      ".birthday-builds/format.md",
      "hidden exact truth",
    );

    const result = await inspectWorkspacePaths(
      ["scratch/handoff.md", ".birthday-builds/format.md", "../secret.md"],
      "unrelated query terms",
      makeContext(root),
    );

    expect(result.evidence.map((item) => item.title)).toEqual([
      "scratch/handoff.md",
      ".birthday-builds/format.md",
    ]);
    expect(result.errors).toEqual([
      {
        path: "../secret.md",
        reason: "path is not a safe relative workspace path",
      },
    ]);
  });
});
