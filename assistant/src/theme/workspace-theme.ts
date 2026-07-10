/**
 * Workspace theme: user- or assistant-authored design-token overrides read
 * from `ui/theme.json` in the workspace. Clients apply the validated tokens
 * on top of the built-in themes (light/dark/velvet).
 *
 * Security posture is a strict whitelist:
 * - only the semantic token slots below are accepted (unknown keys reject),
 * - values must be plain 3- or 6-digit hex colors (no alpha, so the
 *   contrast floor stays meaningful),
 * - text/background pairs must clear a minimum contrast ratio so an
 *   authored theme can never render core copy illegible.
 *
 * Trust-critical chrome (permission prompts, credential entry) does not
 * consume these tokens; this module only governs the expressive surface.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { getWorkspaceDir } from "../util/platform.js";

/** Workspace-relative path clients and the config watcher both key on. */
export const WORKSPACE_THEME_RELATIVE_PATH = "ui/theme.json";

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const hexColor = z
  .string()
  .regex(HEX_COLOR_RE, "must be a 3- or 6-digit hex color like #1a2b3c");

const ThemeTokensSchema = z
  .object({
    accent: hexColor,
    background: hexColor,
    surface: hexColor,
    surfaceRaised: hexColor,
    border: hexColor,
    text: hexColor,
    textMuted: hexColor,
    assistantBubbleBackground: hexColor,
    assistantBubbleText: hexColor,
    userBubbleBackground: hexColor,
    userBubbleText: hexColor,
  })
  .partial()
  .strict();

export type WorkspaceThemeTokens = z.infer<typeof ThemeTokensSchema>;

export const WorkspaceThemeSchema = z
  .object({
    version: z.literal(1),
    base: z.enum(["light", "dark", "velvet", "system"]).optional(),
    tokens: ThemeTokensSchema.optional(),
  })
  .strict();

export type WorkspaceTheme = z.infer<typeof WorkspaceThemeSchema>;

/**
 * Readability floor, not an accessibility certification: blocks themes whose
 * core text would be effectively invisible against its own background.
 */
export const MIN_TEXT_CONTRAST_RATIO = 3;

/**
 * Token pairs that must clear the contrast floor when both sides are
 * present: [foreground, background].
 */
const CONTRAST_PAIRS: readonly [
  keyof WorkspaceThemeTokens,
  keyof WorkspaceThemeTokens,
][] = [
  ["text", "background"],
  ["text", "surface"],
  ["textMuted", "background"],
  ["assistantBubbleText", "assistantBubbleBackground"],
  ["userBubbleText", "userBubbleBackground"],
];

function expandHex(hex: string): string {
  const raw = hex.slice(1);
  if (raw.length === 6) {
    return raw;
  }
  return raw
    .split("")
    .map((c) => c + c)
    .join("");
}

function relativeLuminance(hex: string): number {
  const expanded = expandHex(hex);
  const channels = [0, 2, 4].map((offset) => {
    const value = parseInt(expanded.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG contrast ratio between two hex colors (order-independent). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [lighter, darker] = la >= lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

function contrastIssues(tokens: WorkspaceThemeTokens): string[] {
  const issues: string[] = [];
  for (const [fgKey, bgKey] of CONTRAST_PAIRS) {
    const fg = tokens[fgKey];
    const bg = tokens[bgKey];
    if (!fg || !bg) {
      continue;
    }
    const ratio = contrastRatio(fg, bg);
    if (ratio < MIN_TEXT_CONTRAST_RATIO) {
      issues.push(
        `tokens.${fgKey} on tokens.${bgKey} has contrast ${ratio.toFixed(2)}:1 — minimum is ${MIN_TEXT_CONTRAST_RATIO}:1`,
      );
    }
  }
  return issues;
}

export interface WorkspaceThemeReadResult {
  /** Validated theme, or null when the file is absent or rejected. */
  theme: WorkspaceTheme | null;
  /**
   * "workspace" = valid file applied; "invalid" = file present but rejected
   * (see issues); "none" = no theme file in the workspace.
   */
  source: "workspace" | "invalid" | "none";
  issues: string[];
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

/**
 * Read and validate the workspace theme file. Never throws: an unreadable,
 * unparsable, or out-of-policy file yields `source: "invalid"` with
 * human-readable issues so callers (and the authoring assistant) can surface
 * exactly what was rejected.
 */
export function readWorkspaceTheme(): WorkspaceThemeReadResult {
  const themePath = join(getWorkspaceDir(), WORKSPACE_THEME_RELATIVE_PATH);
  if (!existsSync(themePath)) {
    return { theme: null, source: "none", issues: [] };
  }

  let raw: string;
  try {
    raw = readFileSync(themePath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      theme: null,
      source: "invalid",
      issues: [`failed to read ${WORKSPACE_THEME_RELATIVE_PATH}: ${message}`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      theme: null,
      source: "invalid",
      issues: [`not valid JSON: ${message}`],
    };
  }

  const result = WorkspaceThemeSchema.safeParse(parsed);
  if (!result.success) {
    return {
      theme: null,
      source: "invalid",
      issues: formatZodIssues(result.error),
    };
  }

  const legibility = result.data.tokens
    ? contrastIssues(result.data.tokens)
    : [];
  if (legibility.length > 0) {
    return { theme: null, source: "invalid", issues: legibility };
  }

  return { theme: result.data, source: "workspace", issues: [] };
}
