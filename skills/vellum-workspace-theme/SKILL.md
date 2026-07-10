---
name: vellum-workspace-theme
description: Customize the app's visual theme — author design-token overrides (accent, background, surfaces, text, message-bubble colors) in the workspace ui/theme.json, validated by the assistant runtime and applied live to connected clients. Covers the token slots, the all-or-none override groups, the contrast floor, and reading back validation issues.
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🖌️"
  vellum:
    category: "content"
    display-name: "Workspace Theme"
---

You are customizing the visual theme of the app you and your user share. The theme lives in one file — `$VELLUM_WORKSPACE_DIR/ui/theme.json` — which the assistant runtime validates and serves to every connected client. Valid changes apply **live**, layered on top of the built-in light/dark/velvet base theme: open windows re-color within a few seconds of the file being saved. No restart, no build step.

**All commands in this skill use the `bash` tool.** `$VELLUM_WORKSPACE_DIR` is available in the sandbox environment.

## Inspect current state

Always check what's there before changing it:

```bash
cat "$VELLUM_WORKSPACE_DIR/ui/theme.json" 2>/dev/null || echo "No theme yet — clients render the built-in theme"
```

## The file

A complete example (all eleven token slots — you rarely need all of them):

```json
{
  "version": 1,
  "tokens": {
    "accent": "#e8a04c",
    "background": "#1c1512",
    "surface": "#2b2018",
    "surfaceRaised": "#332619",
    "border": "#43301f",
    "text": "#f2e4d4",
    "textMuted": "#a68d75",
    "userBubbleBackground": "#26201a",
    "userBubbleText": "#efe3d2",
    "assistantBubbleBackground": "#33202a",
    "assistantBubbleText": "#ffd7e4"
  }
}
```

| Token                                               | What it controls                                                                                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accent`                                            | Primary buttons, highlights, active states. The button-label color is derived automatically so it stays readable on any accent.                                |
| `background`                                        | The page background and base surfaces.                                                                                                                         |
| `surface`                                           | Panels, popovers, and overlays.                                                                                                                                |
| `surfaceRaised`                                     | Elevated cards.                                                                                                                                                |
| `border`                                            | Borders and dividers.                                                                                                                                          |
| `text`                                              | Main copy.                                                                                                                                                     |
| `textMuted`                                         | Secondary labels and captions.                                                                                                                                 |
| `userBubbleBackground` / `userBubbleText`           | The user's chat message bubble.                                                                                                                                |
| `assistantBubbleBackground` / `assistantBubbleText` | Accepted and validated, but not yet rendered — assistant messages don't have a themeable container yet. Safe to set now; they light up when the surface ships. |

`"base": "light" | "dark" | "velvet" | "system"` is also accepted at the top level but reserved — clients don't switch the base theme from it yet. The tokens are a color layer over whichever base the user has chosen.

## The rules (why an edit gets rejected)

The runtime validates the whole file and rejects it atomically — one bad value turns theming **off** (clients revert to the built-in theme) until the file is fixed. The rules:

1. **Hex colors only** — 3- or 6-digit (`#f0a`, `#e8a04c`). No alpha channel, no named colors, no CSS functions, no `url()`.
2. **Only the keys above** — unknown top-level keys or token slots reject the file. There is no way to inject arbitrary CSS; that is deliberate.
3. **Override groups are all-or-none.** Tokens that render against each other must be set together, because your overrides layer over a base palette the runtime doesn't resolve:
   - Core group: `background`, `surface`, `surfaceRaised`, `text`, `textMuted` — set any one, set all five.
   - Each bubble pair: background and text together.
   - `accent` and `border` are free agents — fine alone.
4. **Contrast floor** — text/surface pairs must clear **3:1** (WCAG relative luminance): `text` against `background`/`surface`/`surfaceRaised`, `textMuted` against all three, and each bubble's text against its background. The floor blocks illegible themes, not bold ones.
5. **A real file, at most 64KB** — symlinks and oversized files are rejected.

Practical consequence of rule 3: an "accent-only" theme is two lines, but the moment you touch `background` you are authoring a full palette. Design the five core colors together.

## Verify after every edit

The runtime tells you exactly what it accepted or why it refused. Fetch `GET /v1/workspace/theme` from the assistant runtime HTTP API (the same authenticated API used for other configuration reads):

```json
{
  "theme": { "version": 1, "tokens": { "accent": "#e8a04c" } },
  "source": "workspace",
  "issues": []
}
```

- `source: "workspace"` — your theme is live.
- `source: "invalid"` — rejected; `issues` lists human-readable reasons (e.g. `"incomplete override group: setting tokens.background also requires tokens.text, …"` or `"tokens.text on tokens.background has contrast 1.02:1 — minimum is 3:1"`). Fix and re-check.
- `source: "none"` — no theme file exists.

To see the result visually, take a browser screenshot of the app, or ask the user — the change is already on their screen.

## Removing the theme

Delete the file (or write `{"version":1}` with no tokens) and clients revert to the built-in theme:

```bash
rm "$VELLUM_WORKSPACE_DIR/ui/theme.json"
```

## Etiquette

The theme applies to every open window your user has, within seconds, with a small "Theme updated" notice. For a small tweak that was just discussed, go ahead. For a dramatic repaint — or one the user didn't ask for — tell them what you're about to do, or stage the palette in conversation first. It's a shared space; redecorate like someone who lives there too.
