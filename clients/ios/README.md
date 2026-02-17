# iOS App — vellum-assistant-ios

The iOS target (`vellum-assistant-ios`) is part of the multi-platform Swift Package at `clients/Package.swift`.

## iOS Build

The iOS app requires Xcode to build for a device or simulator.

To build for CI using xcodebuild:

```bash
xcodebuild \
  -scheme vellum-assistant-ios \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  build \
  CODE_SIGNING_ALLOWED=NO
```

### Development

1. Open `clients/Package.swift` in Xcode
2. Select the `vellum-assistant-ios` scheme
3. Choose an iOS Simulator as destination
4. Build and Run (⌘R)

## Running Tests

The `VellumAssistantSharedTests` target covers shared IPC logic (e.g. `MockDaemonClient`) and
can be run on macOS without a simulator:

```bash
cd clients/macos
./build.sh test
```

Or directly via SPM from the `clients/` directory:

```bash
cd clients
swift test --filter VellumAssistantSharedTests
```

## Configuration

The iOS app connects to the Vellum daemon over TCP.

| Setting | Default | Description |
|---------|---------|-------------|
| Host    | `localhost` | Daemon hostname (configure in Settings for real device) |
| Port    | `8765` | Daemon TCP port |

For simulator testing the daemon runs on the host Mac, so `localhost` works out of the box.
For real device testing, configure the daemon's network-accessible IP in the app's Settings screen.

## Dependencies

The iOS app depends only on `VellumAssistantShared`. It must **not** import `VellumAssistantLib`,
which links macOS-only frameworks (AppKit, ScreenCaptureKit, etc.).
