# Per-environment Windows app icons

Each environment has a 256x256 ICO asset derived from the matching Vellum
desktop brand color:

- `local`: blue
- `dev`: pink
- `staging`: yellow
- `production`: green

`electron-builder.config.cjs` selects the icon from `VELLUM_ENVIRONMENT` for
the application executable, installer, and uninstaller. Unknown environment
names use the production icon.
