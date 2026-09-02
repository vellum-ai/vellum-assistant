# Per-environment Windows app icons

Each environment has a multi-resolution ICO asset derived from the matching
Vellum desktop brand color. The 16, 24, 32, 48, 64, 128, and 256px entries
cover installed shortcuts, Explorer, the taskbar, and high-DPI displays.

- `local`: blue
- `dev`: pink
- `staging`: yellow
- `production`: green

`electron-builder.config.cjs` selects the icon from `VELLUM_ENVIRONMENT` for
the application executable, installer, and uninstaller. Unknown environment
names use the production icon.
