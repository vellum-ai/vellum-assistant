# Fix macOS App Icon Regression & Add Per-Environment Icon Infrastructure

## Overview
PR #27022 migrated the macOS app icon from `AppIcon.appiconset` (raster PNGs) to the Xcode-26 Icon Composer `.icon` bundle format. This broke the Finder/DMG icon because `actool` with the `.icon` bundle only emits the icon into `Assets.car` — it no longer generates a standalone `AppIcon.icns` file that macOS Finder and `create-dmg` rely on for icon display. This plan fixes the regression by adding a build step to generate `AppIcon.icns` from the existing SVG source, and sets up per-environment icon infrastructure so different environments (local, dev, staging, production) can use distinct icon assets in the future.

## PR 1: Generate AppIcon.icns from SVG in build.sh
### Depends on
None

### Branch
fix-macos-icon/pr-1-generate-icns

### Title
fix(macos): generate AppIcon.icns from SVG to restore Finder/DMG icon

### Files
- `clients/macos/build.sh`

### Implementation steps
1. In `clients/macos/build.sh`, after the `actool` invocation block (line 1360) and before the `VellumDocument.icns` copy (line 1363), add a new section that generates `AppIcon.icns` from the SVG source.

2. The generation step should:
   - Use `sips` and `iconutil` (both ship with macOS, no extra dependencies) to produce the `.icns`.
   - Create a temporary `.iconset` directory with PNGs at all required sizes per Apple's iconutil spec: 16, 32, 128, 256, 512 at both 1x and 2x (10 files total, named `icon_NxN.png` and `icon_NxN{at}2x.png`).
   - Render the white-V SVG onto the Vellum green background at 1024x1024 as the master image, then downsample. Use a small inline Swift script (executed via `swift -`) to:
     - Read the SVG from `$APP_ICON/Assets/white-V.svg`
     - Read the fill color from `$APP_ICON/icon.json` (the `fill.solid` field, which is `display-p3:0.12941,0.42353,0.21569,1.00000`)
     - Render a 1024x1024 PNG with the green fill as a rounded-rect (matching macOS squircle proportions) and the white V centered, matching the scale (6) and translation ([0, 25]) from `icon.json`
   - Use `sips -z <H> <W>` to create each required size from the 1024x1024 master.
   - Run `iconutil --convert icns --output "$RESOURCES_DIR/AppIcon.icns" <iconset-dir>` to produce the final `.icns`.
   - Clean up the temporary iconset directory.

3. Guard the entire block so it only runs if `AppIcon.icns` is not already present in `$RESOURCES_DIR` (allowing a pre-built `.icns` to take precedence — this becomes relevant for per-environment icons in PR 2).

4. The inline Swift script approach is consistent with how `dmg/generate-background.swift` already works in this codebase — using Swift for image generation from the build script. Keep the script inline (heredoc) rather than a separate file since it's tightly coupled to the build step.

5. Remove the `> /dev/null 2>&1 || true` error suppression on the `actool` invocation (line 1359) and replace with proper error handling that only suppresses warnings but surfaces real failures. This prevents future icon issues from being silently swallowed.

### Acceptance criteria
- Running `./build.sh` produces `dist/Vellum.app/Contents/Resources/AppIcon.icns` that contains the white V on green background
- The `.icns` file contains all required icon sizes (16 through 512@2x)
- Running `./build.sh release-application` produces a DMG where the app shows the Vellum icon (not the generic grid placeholder)
- The `actool` step still produces `Assets.car` with the Liquid Glass icon for macOS Tahoe
- Both `CFBundleIconFile` (legacy `.icns` lookup) and `CFBundleIconName` (modern `Assets.car` lookup) continue to work

## PR 2: Add per-environment icon directory structure
### Depends on
PR 1

### Branch
fix-macos-icon/pr-2-env-icon-dirs

### Title
feat(macos): add per-environment app icon infrastructure

### Files
- `clients/macos/vellum-assistant/Resources/icons/production/icon.json`
- `clients/macos/vellum-assistant/Resources/icons/production/Assets/white-V.svg`
- `clients/macos/vellum-assistant/Resources/icons/README.md`
- `clients/macos/build.sh`

### Implementation steps
1. Create a new directory structure under `clients/macos/vellum-assistant/Resources/icons/` organized by environment:
   ```
   icons/
   ├── README.md
   └── production/
       ├── icon.json
       └── Assets/
           └── white-V.svg
   ```

2. Copy the current `AppIcon.icon/icon.json` and `AppIcon.icon/Assets/white-V.svg` into `icons/production/`. This is the canonical source — the production icon.

3. Create `icons/README.md` with instructions explaining:
   - The directory structure: one subdirectory per `VELLUM_ENVIRONMENT` value (`local`, `dev`, `staging`, `production`)
   - Each directory contains an `icon.json` (Icon Composer format with `fill.solid` color and layer definitions) and an `Assets/` folder with the SVG
   - To add a new environment icon: create a directory matching the environment name (e.g., `staging/`) with an `icon.json` and `Assets/white-V.svg`. The `fill.solid` color in `icon.json` controls the background tint. The easiest customization is changing just the color.
   - If no directory exists for the current environment, the build falls back to `production/`

4. In `build.sh`, before the `actool` invocation (around line 1346), add environment-aware icon resolution:
   ```bash
   # Resolve per-environment icon source. Falls back to production if no
   # environment-specific override exists.
   ICONS_DIR="$SCRIPT_DIR/vellum-assistant/Resources/icons"
   if [ -d "$ICONS_DIR/$VELLUM_ENVIRONMENT" ]; then
       ICON_SOURCE_DIR="$ICONS_DIR/$VELLUM_ENVIRONMENT"
   elif [ -d "$ICONS_DIR/production" ]; then
       ICON_SOURCE_DIR="$ICONS_DIR/production"
   else
       ICON_SOURCE_DIR=""
   fi
   ```

5. If `$ICON_SOURCE_DIR` is non-empty, copy its contents into `AppIcon.icon/` before `actool` runs:
   ```bash
   if [ -n "$ICON_SOURCE_DIR" ]; then
       # Overlay environment-specific icon into the .icon bundle
       cp "$ICON_SOURCE_DIR/icon.json" "$APP_ICON/icon.json"
       cp -R "$ICON_SOURCE_DIR/Assets/" "$APP_ICON/Assets/"
   fi
   ```
   This ensures both `actool` (for `Assets.car` / Liquid Glass) and the `.icns` generation step (from PR 1) use the environment-appropriate icon source.

6. Update the `.icns` generation guard from PR 1: instead of checking for existence, always regenerate when `$ICON_SOURCE_DIR` is set (to pick up environment-specific colors). The generation step should read the fill color from the resolved `icon.json` (which may have been overwritten by the environment overlay).

### Acceptance criteria
- `icons/production/` contains the same `icon.json` and SVG as the current `AppIcon.icon/`
- Building with `VELLUM_ENVIRONMENT=production` uses the production icon (green background)
- Building with `VELLUM_ENVIRONMENT=staging` falls back to the production icon (no staging override yet) — no error, no missing icon
- The README clearly documents how to add new environment icons
- The `AppIcon.icon/` bundle in the source tree is treated as a working copy that gets overwritten at build time — not a source of truth
- A developer can add a `staging/` directory with a different `fill.solid` color in `icon.json` and see a different icon color after building
