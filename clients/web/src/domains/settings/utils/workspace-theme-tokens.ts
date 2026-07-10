/**
 * Maps the daemon's semantic workspace-theme tokens onto the concrete
 * design-library CSS variables the app consumes, and applies them as inline
 * custom properties on the document root (layered over the active
 * light/dark/velvet base theme).
 *
 * The mapping is intentionally comprehensive per token: setting `text` writes
 * the whole content-color ramp, not just `--content-default`, so a base-theme
 * text shade can never survive alongside an authored background and clash.
 * The daemon has already validated contrast for text/background/surface pairs
 * (see assistant `theme/workspace-theme.ts`), so a fanned-out override is safe.
 *
 * The assistant-message bubble pair is intentionally not mapped here: assistant
 * messages render as full-width text with no themeable container today, and
 * applying bubble text without a matching background would reintroduce the
 * readability hole the daemon's pair-contrast check cannot see across the page
 * background. Those tokens still validate server-side; their client
 * application waits on a dedicated assistant-bubble surface.
 */

/** The token names served by `GET /v1/workspace/theme`. */
export interface WorkspaceThemeTokens {
  accent?: string;
  background?: string;
  surface?: string;
  surfaceRaised?: string;
  border?: string;
  text?: string;
  textMuted?: string;
  assistantBubbleBackground?: string;
  assistantBubbleText?: string;
  userBubbleBackground?: string;
  userBubbleText?: string;
}

export interface WorkspaceTheme {
  version: 1;
  base?: "light" | "dark" | "velvet" | "system";
  tokens?: WorkspaceThemeTokens;
}

/**
 * Each semantic token fans out to the design-library variables it should
 * control. Grouped so no base-theme color in the same visual role leaks
 * through a partial override.
 */
const TOKEN_TO_CSS_VARS: Record<
  keyof WorkspaceThemeTokens,
  readonly string[]
> = {
  accent: ["--primary-base", "--primary-hover", "--primary-active"],
  background: ["--background", "--surface-base", "--surface-sunken"],
  surface: ["--surface-overlay", "--surface-active"],
  surfaceRaised: ["--surface-lift"],
  border: ["--border-base", "--border-element", "--border-subtle"],
  text: [
    "--foreground",
    "--content-default",
    "--content-emphasised",
    "--content-strong",
  ],
  textMuted: [
    "--content-secondary",
    "--content-tertiary",
    "--content-quiet",
    "--content-faint",
  ],
  userBubbleBackground: ["--user-bubble-bg"],
  userBubbleText: ["--user-bubble-text"],
  // Deferred until assistant messages have a themeable surface (see docstring).
  assistantBubbleBackground: [],
  assistantBubbleText: [],
};

/** The full set of CSS variables this layer may set — used to clear cleanly. */
export const WORKSPACE_THEME_CSS_VARS: readonly string[] = Object.values(
  TOKEN_TO_CSS_VARS,
).flat();

/**
 * Resolve a theme's tokens into the flat `{ cssVar: value }` overrides to
 * apply. Unset tokens contribute nothing.
 */
export function resolveThemeCssVars(
  tokens: WorkspaceThemeTokens | undefined,
): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!tokens) {
    return vars;
  }
  for (const [token, value] of Object.entries(tokens)) {
    if (!value) {
      continue;
    }
    const cssVars = TOKEN_TO_CSS_VARS[token as keyof WorkspaceThemeTokens];
    for (const cssVar of cssVars ?? []) {
      vars[cssVar] = value;
    }
  }
  return vars;
}

/**
 * Apply a validated workspace theme's token overrides to the document root,
 * clearing any previously-applied overrides first so a demoted token reverts
 * to its base-theme value. Idempotent; safe to call on every theme change.
 */
export function applyWorkspaceThemeTokens(
  tokens: WorkspaceThemeTokens | undefined,
): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const next = resolveThemeCssVars(tokens);
  for (const cssVar of WORKSPACE_THEME_CSS_VARS) {
    if (cssVar in next) {
      root.style.setProperty(cssVar, next[cssVar]);
    } else {
      root.style.removeProperty(cssVar);
    }
  }
}
