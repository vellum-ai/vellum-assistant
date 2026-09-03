# Per-environment Windows app icons

Each environment has a multi-resolution ICO asset derived from the matching
Vellum desktop brand color. The 16, 24, 32, 48, 64, 128, and 256px entries
cover installed shortcuts, Explorer, the taskbar, and high-DPI displays.

- `local`: blue
- `dev`: pink, `#FF88C9`
- `staging`: yellow, `#E9C91A`
- `production`: green, `#4C9B50`

The three shipped grounds are the same palette the macOS, Linux, and iOS icon
manifests carry. Windows has no generator in the tree, so an environment's ICO
has to be re-rendered by hand when its ground changes.
`clients/ios/scripts/__tests__/desktop-icon-ground.test.ts` decodes each of
those ICOs and holds its ground to the matching iOS bundle, so a palette change
that skips the re-render fails there.
`scripts/identity-assets.test.ts` holds the size set and the
one-ICO-per-environment guarantee.

`electron-builder.config.cjs` selects the icon from `VELLUM_ENVIRONMENT` for
the application executable, installer, and uninstaller. Unknown environment
names use the production icon.
