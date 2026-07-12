import { execSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  contrastRatio,
  MAX_THEME_FILE_BYTES,
  MIN_TEXT_CONTRAST_RATIO,
  readWorkspaceTheme,
  WORKSPACE_THEME_RELATIVE_PATH,
} from "./workspace-theme.js";

describe("readWorkspaceTheme", () => {
  let workspaceDir: string;
  let prevWorkspaceDir: string | undefined;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "workspace-theme-test-"));
    prevWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  });

  afterEach(() => {
    if (prevWorkspaceDir === undefined) {
      delete process.env.VELLUM_WORKSPACE_DIR;
    } else {
      process.env.VELLUM_WORKSPACE_DIR = prevWorkspaceDir;
    }
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function writeTheme(content: string): void {
    const themePath = join(workspaceDir, WORKSPACE_THEME_RELATIVE_PATH);
    mkdirSync(join(workspaceDir, "ui"), { recursive: true });
    writeFileSync(themePath, content);
  }

  test("absent file yields source none with no issues", () => {
    const result = readWorkspaceTheme();
    expect(result).toEqual({ theme: null, source: "none", issues: [] });
  });

  test("valid theme parses with all token slots", () => {
    writeTheme(
      JSON.stringify({
        version: 1,
        base: "dark",
        tokens: {
          accent: "#e8a04c",
          background: "#1c1512",
          surface: "#2b2018",
          surfaceRaised: "#332619",
          border: "#43301f",
          text: "#f2e4d4",
          textMuted: "#a68d75",
          assistantBubbleBackground: "#33202a",
          assistantBubbleText: "#ffd7e4",
          userBubbleBackground: "#26201a",
          userBubbleText: "#efe3d2",
        },
      }),
    );
    const result = readWorkspaceTheme();
    expect(result.source).toBe("workspace");
    expect(result.issues).toEqual([]);
    expect(result.theme?.base).toBe("dark");
    expect(result.theme?.tokens?.accent).toBe("#e8a04c");
  });

  test("minimal theme (version only) is valid", () => {
    writeTheme(JSON.stringify({ version: 1 }));
    const result = readWorkspaceTheme();
    expect(result.source).toBe("workspace");
    expect(result.theme).toEqual({ version: 1 });
  });

  test("3-digit hex colors are accepted", () => {
    writeTheme(JSON.stringify({ version: 1, tokens: { accent: "#f0a" } }));
    const result = readWorkspaceTheme();
    expect(result.source).toBe("workspace");
  });

  test("unknown top-level keys are rejected", () => {
    writeTheme(JSON.stringify({ version: 1, css: "body { display: none }" }));
    const result = readWorkspaceTheme();
    expect(result.source).toBe("invalid");
    expect(result.theme).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
  });

  test("unknown token slots are rejected", () => {
    writeTheme(
      JSON.stringify({ version: 1, tokens: { zIndexOverlay: "#000000" } }),
    );
    const result = readWorkspaceTheme();
    expect(result.source).toBe("invalid");
    expect(result.theme).toBeNull();
  });

  test("non-hex values are rejected, including alpha hex and CSS functions", () => {
    for (const value of ["#aabbccdd", "red", "url(http://evil)", "#12"]) {
      writeTheme(JSON.stringify({ version: 1, tokens: { accent: value } }));
      const result = readWorkspaceTheme();
      expect(result.source).toBe("invalid");
      expect(result.theme).toBeNull();
    }
  });

  test("unsupported version is rejected", () => {
    writeTheme(JSON.stringify({ version: 2 }));
    const result = readWorkspaceTheme();
    expect(result.source).toBe("invalid");
  });

  test("malformed JSON is rejected with a readable issue", () => {
    writeTheme("{ version: 1 ");
    const result = readWorkspaceTheme();
    expect(result.source).toBe("invalid");
    expect(result.issues[0]).toContain("not valid JSON");
  });

  test("illegible text/background pair is rejected by the contrast floor", () => {
    writeTheme(
      JSON.stringify({
        version: 1,
        tokens: {
          text: "#fefefe",
          textMuted: "#555555",
          background: "#ffffff",
          surface: "#f2f2f2",
          surfaceRaised: "#e8e8e8",
        },
      }),
    );
    const result = readWorkspaceTheme();
    expect(result.source).toBe("invalid");
    expect(result.theme).toBeNull();
    expect(result.issues[0]).toContain("contrast");
  });

  test("partial core override group is rejected, naming the missing tokens", () => {
    writeTheme(
      JSON.stringify({ version: 1, tokens: { background: "#000000" } }),
    );
    const result = readWorkspaceTheme();
    expect(result.source).toBe("invalid");
    expect(result.theme).toBeNull();
    expect(result.issues[0]).toContain("incomplete override group");
    expect(result.issues[0]).toContain("tokens.text");
  });

  test("partial bubble pair is rejected", () => {
    writeTheme(
      JSON.stringify({
        version: 1,
        tokens: { assistantBubbleBackground: "#33202a" },
      }),
    );
    const result = readWorkspaceTheme();
    expect(result.source).toBe("invalid");
    expect(result.issues[0]).toContain("incomplete override group");
  });

  test("group-exempt tokens (accent, border) are valid alone", () => {
    writeTheme(
      JSON.stringify({
        version: 1,
        tokens: { accent: "#e8a04c", border: "#43301f" },
      }),
    );
    const result = readWorkspaceTheme();
    expect(result.source).toBe("workspace");
    expect(result.issues).toEqual([]);
  });

  test("bubble text/background pairs are contrast-checked", () => {
    writeTheme(
      JSON.stringify({
        version: 1,
        tokens: {
          assistantBubbleText: "#111111",
          assistantBubbleBackground: "#141414",
        },
      }),
    );
    const result = readWorkspaceTheme();
    expect(result.source).toBe("invalid");
    expect(result.issues[0]).toContain("contrast");
  });

  test("muted text is contrast-checked against surfaces, not just background", () => {
    writeTheme(
      JSON.stringify({
        version: 1,
        tokens: {
          background: "#0a0a0a",
          surface: "#6b6b6b",
          surfaceRaised: "#6f6f6f",
          text: "#ffffff",
          textMuted: "#777777",
        },
      }),
    );
    const result = readWorkspaceTheme();
    expect(result.source).toBe("invalid");
    expect(result.issues.join("\n")).toContain("textMuted on tokens.surface");
  });

  test("symlinked theme file is rejected without following it", () => {
    const target = join(workspaceDir, "elsewhere.json");
    writeFileSync(target, JSON.stringify({ version: 1 }));
    mkdirSync(join(workspaceDir, "ui"), { recursive: true });
    symlinkSync(target, join(workspaceDir, WORKSPACE_THEME_RELATIVE_PATH));
    const result = readWorkspaceTheme();
    expect(result.source).toBe("invalid");
    expect(result.theme).toBeNull();
    expect(result.issues[0]).toContain("symbolic link");
  });

  test("oversized theme file is rejected before parsing", () => {
    writeTheme(`{"version":1}${" ".repeat(MAX_THEME_FILE_BYTES)}`);
    const result = readWorkspaceTheme();
    expect(result.source).toBe("invalid");
    expect(result.issues[0]).toContain("maximum");
  });

  test("FIFO at the theme path is rejected without blocking", () => {
    const fifoPath = join(workspaceDir, WORKSPACE_THEME_RELATIVE_PATH);
    mkdirSync(join(workspaceDir, "ui"), { recursive: true });
    execSync(`mkfifo "${fifoPath}"`);
    const result = readWorkspaceTheme();
    expect(result.source).toBe("invalid");
    expect(result.theme).toBeNull();
    expect(result.issues[0]).toContain("regular file");
  });
});

describe("contrastRatio", () => {
  test("black on white is the maximum 21:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });

  test("identical colors are 1:1", () => {
    expect(contrastRatio("#336699", "#336699")).toBeCloseTo(1, 5);
  });

  test("is order-independent", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBe(
      contrastRatio("#ffffff", "#000000"),
    );
  });

  test("floor constant catches near-invisible text", () => {
    expect(contrastRatio("#fefefe", "#ffffff")).toBeLessThan(
      MIN_TEXT_CONTRAST_RATIO,
    );
    expect(contrastRatio("#f2e4d4", "#1c1512")).toBeGreaterThan(
      MIN_TEXT_CONTRAST_RATIO,
    );
  });
});
