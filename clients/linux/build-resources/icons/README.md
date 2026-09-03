# Per-environment Linux app icons

Each subdirectory is one `VELLUM_ENVIRONMENT` value and holds the sources
`scripts/generate-icon.sh` composites into the packaged app.

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

These manifests mirror `clients/macos/build-resources/icons/` so both desktop
builds ship the same ground. Keep the two in step: edit one and edit the other.
`clients/ios/scripts/__tests__/desktop-icon-ground.test.ts` fails when they
drift apart.

## The palette

The ground is written as `display-p3:<r>,<g>,<b>,<a>` with components in 0..1.
The three shipped environments share one palette with the iOS bundles under
`clients/ios/App/App/AppIcon*.icon`:

| Environment | sRGB      | `fill.solid`                                 |
| ----------- | --------- | -------------------------------------------- |
| production  | `#4C9B50` | `display-p3:0.37749,0.60064,0.34581,1.00000` |
| staging     | `#E9C91A` | `display-p3:0.89313,0.79283,0.28410,1.00000` |
| dev         | `#FF88C9` | `display-p3:0.93870,0.55755,0.77770,1.00000` |

`local` keeps a blue ground of its own and sits outside that palette, because it
never leaves a developer machine.

## How it works

`scripts/pack.sh` runs `scripts/generate-icon.sh` before electron-builder, which
packages the result as `build/icon.png`. That script:

1. Resolves `build-resources/icons/$VELLUM_ENVIRONMENT/`, falling back to
   `production/` when no directory matches.
2. Requires `rsvg-convert` and ImageMagick on `PATH`, accepting either the
   ImageMagick 7 `magick` binary or the ImageMagick 6 `convert` binary.
3. Reads `fill.solid` and converts the Display P3 components to an sRGB
   `rgb(r,g,b)` triple: linearize with the sRGB EOTF, rotate through XYZ at D65,
   re-encode, and clamp. macOS hands the same components to CoreGraphics in the
   Display P3 space, so the conversion is what keeps the two platforms rendering
   one color. Reading the components straight into sRGB instead desaturates
   every ground.
4. Renders `Assets/white-V.svg` at 1024x1024 with `rsvg-convert` and composites
   it centered over the flat ground into `build/icon.png`.

Linux has no CoreGraphics, so this pipeline is a flat composite rather than the
Icon Composer render the macOS script performs. It scales the foreground to the
full canvas and centers it instead of applying the manifest's `position` block,
so a change to `position.scale` or `translation-in-points` moves the macOS icon
and leaves the Linux one where it was.

## Adding an environment

1. Create a directory named for the environment.
2. Copy `production/icon.json` and `production/Assets/white-V.svg` into it.
3. Set `fill.solid` to the environment's ground.
4. Mirror the same directory under `clients/macos/build-resources/icons/`.
5. Build with `VELLUM_ENVIRONMENT=<name> bash scripts/pack.sh` and check
   `build/icon.png`.
