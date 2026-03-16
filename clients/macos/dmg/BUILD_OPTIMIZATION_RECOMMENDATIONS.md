# macOS DMG Build Optimization Recommendations

## Main Time Contributors

The DMG build is a single sequential job with these major phases:

1. **Bun binary compilation (~2-3 min)**: Compiles 4 separate Bun binaries sequentially (daemon, assistant-cli, cli, gateway), each running its own `bun install` + `bun build --compile`.
2. **Swift build (~2-4 min)**: Full `swift build -c release` — clean build every time in release mode. SPM caching helps but cache misses are expensive.
3. **Code signing (~30s-1 min)**: Signs Sparkle.framework internals, Quick Look extensions, all binaries individually, then the outer app bundle — all sequentially.
4. **DMG creation + notarization (~2-5 min)**: `brew install create-dmg`, generate background PNG, create DMG, `notarytool submit --wait` (blocks on Apple servers 1-5 min), stapling with retry loop.
5. **Sparkle tooling (release only, ~1 min)**: `brew install sparkle`, generate appcast.xml, sign the ZIP.

## Optimization Recommendations

### High Impact

1. **Parallelize Bun binary builds**: The 4 binaries (daemon, assistant-cli, cli, gateway) are independent. Run them in parallel with `&` + `wait`. Could cut ~2 min down to ~45s.

2. **Cache Homebrew packages**: `create-dmg` and `sparkle` are installed via `brew install` on every run. Cache them or use a pre-baked runner image. Could save 30-60s.

3. **Pre-generate the DMG background**: The `generate-background.swift` script produces a deterministic image. Commit the PNG to the repo and skip the runtime Swift compilation. Saves ~5-10s per build.

4. **Split build and notarization into separate jobs**: Build the `.app` and DMG in one job, upload as artifact, then notarize in a parallel/subsequent job. This lets you fail fast on build issues without waiting for notarization.

### Medium Impact

5. **Use `SKIP_CLEAN=1` in PR builds** (already done in `ci-main-macos.yaml` but consider for release too with proper cache keys). The release workflow force-cleans `.build`, which throws away all SPM compilation cache.

6. **Share `bun install` across binaries**: The daemon, assistant-cli all use the same `assistant/` source dir. Currently `build_bun_binary` runs `bun install` for each invocation. The first call installs; subsequent calls are fast but still redundant. Pre-install once before building.

7. **Notarization staple retry**: The retry loop starts at 60s and can wait up to 15 x (60+increments) = potentially 15+ minutes in worst case. Consider shorter initial waits (Apple CDN propagation is usually <30s now).

### Lower Impact

8. **Cache SPM binary artifacts**: The `~/.netrc` approach for GitHub-hosted SPM binaries causes re-downloads. Consider caching `~/Library/Caches/org.swift.swiftpm/artifacts`.

9. **Avoid redundant `bun install` in x64 build**: The `build-macos-x64` job re-installs everything from scratch. Share the node_modules via artifact caching.
