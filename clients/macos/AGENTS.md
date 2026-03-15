# macOS Client — Agent Guidance

## Build Flags

- When building the macOS client against Apple `containerization` `0.1.1` on Xcode 16.x, export `CURRENT_SDK=1`. `clients/macos/build.sh` now does this automatically when the active Xcode major version is below 26.
- `clients/macos/build.sh` bundles the Kata 3.17.0 ARM64 kernel into `Vellum.app/Contents/Resources/DeveloperVM/` and caches the downloaded archive under `clients/.build/developer-vm/`.
## Keyboard Shortcuts

When adding a new keyboard shortcut to the macOS app, you **must** also add a corresponding configurable key binding in the "Keyboard Shortcuts" section of the Settings/General page. Users should be able to customize every shortcut — do not hard-code key bindings without a matching settings entry.
