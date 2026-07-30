# Per-Environment App Icons

This directory contains per-environment icon sources for the macOS app.
Each subdirectory corresponds to a `VELLUM_ENVIRONMENT` value and holds the
Icon Composer assets that `build.sh` copies into `AppIcon.icon/` before the
build compiles them.

## Directory structure

```
icons/
  README.md
  production/          # VELLUM_ENVIRONMENT=production (canonical/default)
    icon.json          # Icon Composer manifest (fill color, layer definitions)
    Assets/
      white-V.svg      # Foreground SVG layer
  staging/             # (example) VELLUM_ENVIRONMENT=staging
    icon.json
    Assets/
      white-V.svg
```

One subdirectory per environment: `local`, `dev`, `staging`, `production`.
If no directory exists for the current `VELLUM_ENVIRONMENT`, the build falls
back to `production/`.

## Adding a new environment icon

1. Create a directory matching the environment name (e.g. `staging/`).
2. Copy `production/icon.json` and `production/Assets/white-V.svg` into it.
3. Edit `icon.json` to change the `fill.solid` color. This controls the
   background tint of the app icon. The color format is
   `display-p3:<red>,<green>,<blue>,<alpha>` with values between 0 and 1.
4. Optionally replace `Assets/white-V.svg` with a different foreground SVG.
5. Build with `VELLUM_ENVIRONMENT=staging ./build.sh run` (or whichever
   environment you added) and verify the icon.

The easiest customization is changing just the `fill.solid` color in
`icon.json` to give each environment a distinct background tint while keeping
the same white-V foreground.

## How it works

`build.sh` resolves the icon source directory at build time:

1. Checks for `icons/$VELLUM_ENVIRONMENT/`.
2. Falls back to `icons/production/` if the environment directory is missing.
3. Copies `icon.json` and `Assets/` from the resolved directory into
   `AppIcon.icon/`, overwriting its contents.
4. `actool` and the `.icns` generation step then read from `AppIcon.icon/`,
   so both Liquid Glass and Finder/DMG icons reflect the environment color.

`AppIcon.icon/` in the source tree is treated as a working copy that gets
overwritten at build time -- it is not the source of truth.
