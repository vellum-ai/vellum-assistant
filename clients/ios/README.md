# Vellum Assistant iOS App

## Building and Running

### Issue with SPM Executable Targets

Swift Package Manager's `executableTarget` type doesn't properly support iOS app bundles. iOS apps require proper bundle configuration including Info.plist processing, which SPM doesn't handle for executable targets.

### Recommended Build Method

**Option 1: Open in Xcode (Recommended)**

1. Open `clients/Package.swift` in Xcode:
   ```bash
   open clients/Package.swift
   ```

2. In Xcode's scheme selector, choose `vellum-assistant-ios`

3. Select your target iOS Simulator

4. Build and run (⌘R)

**Option 2: Use xcodebuild**

```bash
cd clients
xcodebuild -scheme vellum-assistant-ios \
  -destination 'platform=iOS Simulator,name=iPhone 15' \
  -derivedDataPath .build \
  build
```

### Known Issues

- The iOS app cannot be built with `swift build` directly
- The bundle identifier crash occurs when SPM's auto-generated Info.plist is used
- The `ios/Resources/Info.plist` file is excluded from the SPM build and must be handled by Xcode

### Future Work

Consider migrating to a proper Xcode project structure for the iOS app to avoid SPM limitations.
