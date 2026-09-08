# Per-environment macOS app icons

Each subdirectory is one `VELLUM_ENVIRONMENT` value and holds the Icon Composer
sources `scripts/generate-icon.sh` renders into the packaged app.

```
icons/
  README.md
  production/
    icon.json          # manifest: `fill.solid` ground plus the layer geometry
    Assets/
      white-V.svg      # foreground layer
  staging/
  dev/
  local/
```

## The palette

The ground is written as `display-p3:<r>,<g>,<b>,<a>` with components in 0..1,
and the renderer treats it as a genuine Display P3 color. The three shipped
environments share one palette with the iOS bundles under
`clients/ios/App/App/AppIcon*.icon`, which
`clients/ios/scripts/__tests__/desktop-icon-ground.test.ts` pins:

| Environment | sRGB      | `fill.solid`                                 |
| ----------- | --------- | -------------------------------------------- |
| production  | `#4C9B50` | `display-p3:0.37749,0.60064,0.34581,1.00000` |
| staging     | `#E9C91A` | `display-p3:0.89313,0.79283,0.28410,1.00000` |
| dev         | `#FF88C9` | `display-p3:0.93870,0.55755,0.77770,1.00000` |

`local` keeps a blue ground of its own and sits outside that palette, because it
never leaves a developer machine.

`clients/linux/build-resources/icons/` mirrors these manifests for the Linux
build, and the guard test fails if the two mirrors drift apart.

## How it works

`scripts/pack.sh` runs `scripts/generate-icon.sh` before electron-builder. That
script:

1. Resolves `build-resources/icons/$VELLUM_ENVIRONMENT/`, falling back to
   `production/` when no directory matches.
2. Renders a 1024x1024 master PNG with an inline Swift program. It reads
   `fill.solid` into a `CGColor` in the Display P3 color space, pulls the `d`
   and `viewBox` attributes out of `Assets/white-V.svg`, and draws the path at
   the manifest's `position.scale` and `translation-in-points`. The ground is
   full bleed with no rounding: macOS Tahoe reads edge pixel alpha and applies
   its own squircle clip, and transparent corners would trip its gray border
   instead.
3. Downsamples the master with `sips` into an iconset at 16, 32, 128, 256, and
   512 points at 1x and 2x, then writes `build/icon.icns` with `iconutil`.
4. Compiles a temporary `AppIcon.icon` bundle into `build/Assets.car` with
   `actool` when full Xcode is selected. `actool` ships with Xcode rather than
   the Command Line Tools, so the step is skipped when it is missing and the
   `.icns` serves as the `CFBundleIconFile` fallback. `scripts/afterPack.js`
   copies `Assets.car` into the app bundle only when the step produced one.

There is no working copy of these sources anywhere else in the tree. The
directories here are the source of truth.

## Adding an environment

1. Create a directory named for the environment.
2. Copy `production/icon.json` and `production/Assets/white-V.svg` into it.
3. Set `fill.solid` to the environment's ground.
4. Mirror the same directory under `clients/linux/build-resources/icons/`.
5. Build with `VELLUM_ENVIRONMENT=<name> bash scripts/pack.sh` and check the
   icon Finder displays.
