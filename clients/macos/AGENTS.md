# macOS Client — Agent Guidance

## Keyboard Shortcuts

When adding a new keyboard shortcut to the macOS app, you **must** also add a corresponding configurable key binding in the "Keyboard Shortcuts" section of the Settings/General page. Users should be able to customize every shortcut — do not hard-code key bindings without a matching settings entry.

## Apple Containers Runtime

### Module boundary

The main app target (`VellumAssistantLib`, `clients/Package.swift`) targets macOS 14. Code that imports `Containerization` or `ContainerizationOCI` **must** live inside the nested package at `clients/macos/apple-containers-runtime/` which targets macOS 15+. Never add Apple Containerization imports to the main package targets.

### Build path

`build.sh` probes the SDK version at build time:
- If the active SDK is macOS 15+ (`CURRENT_SDK=1`), `build_apple_containers_runtime()` compiles the nested package, assembles `AppleContainersRuntime.framework`, and embeds it in `Contents/Frameworks/`.
- If the SDK is older, the framework is omitted. `AppleContainersRuntimeLoader` returns `.notEmbedded` at runtime and the feature degrades gracefully — do not treat an absent framework as an error in the main build.

### Feature flag gate

All Apple Containers surfaces **must** consult `AppleContainersAvailabilityChecker.shared.check()` before activating. Do not perform ad hoc feature flag, OS version, or `dlopen` checks outside that checker. The check is cached after the first call.

### Rollout flag: `apple_containers_enabled`

- Scope: `macos` (UserDefaults, per-device, not synced to the gateway).
- Default: `false` (off).
- Env override: `VELLUM_FLAG_APPLE_CONTAINERS_ENABLED=1`.
- Do not change `defaultEnabled` to `true` until the feature is verified on the full OS matrix (see upstream gap note below).

### No shell-out contract

`AppleContainersPodRuntime` and `KataKernelStore` must never invoke `container`, `docker`, or any external binary to manage the pod or kernel images. All orchestration goes through the `Containerization` Swift framework APIs (`LinuxPod`, `ImageStore`, `EXT4Unpacker`).

### Upstream OS support gap

Apple's `container` and `containerization` READMEs currently document macOS 26 + Xcode 26, while the package manifest says `.macOS("15")`. Keep the feature behind the rollout flag and the `AppleContainersAvailabilityChecker` runtime capability checks until it is manually verified on the target OS matrix. Document any verified OS/SDK combinations in `clients/macos/README.md`.
