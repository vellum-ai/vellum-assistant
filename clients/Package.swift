// swift-tools-version: 5.9
import PackageDescription

let appVersion = "0.2.4"

let package = Package(
    name: "vellum-assistant",
    platforms: [
        .macOS(.v14),
        .iOS(.v17)
    ],
    products: [
        .library(
            name: "VellumAssistantLib",
            targets: ["VellumAssistantLib"]
        ),
        .library(
            name: "VellumAssistantShared",
            targets: ["VellumAssistantShared"]
        ),
        .executable(
            name: "vellum-assistant",
            targets: ["vellum-assistant"]
        )
        // iOS executable product removed — use ios/vellum-assistant-ios.xcodeproj instead.
    ],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.0.0"),
    ],
    targets: [
        .target(
            name: "VellumAssistantShared",
            dependencies: [],
            path: "shared",
            exclude: ["Tests"],
            swiftSettings: [
                .enableUpcomingFeature("BareSlashRegexLiterals")
            ],
            linkerSettings: [
                .linkedFramework("Network")  // Required for DaemonClient (NWConnection)
            ]
        ),
        // VellumAssistantLib: macOS-only target (links AppKit, ScreenCaptureKit, etc.)
        // iOS apps should depend only on VellumAssistantShared, not this target.
        .target(
            name: "VellumAssistantLib",
            dependencies: ["VellumAssistantShared", "Sparkle"],
            path: "macos/vellum-assistant",
            exclude: ["Resources/Info.plist", "Resources/bg.png"],
            resources: [
                .process("Resources/Assets.xcassets"),
                .process("Resources/meadow.svg"),
                .process("Resources/background.png"),
                .process("Resources/Fonts"),
                .copy("Resources/Recipes"),
                .process("Resources/Onboarding"),
                .process("Resources/vellum-design-system.css"),
                .process("Resources/vellum-widgets.js"),
                .process("Resources/vellum-edit-animator.js")
            ],
            linkerSettings: [
                .linkedFramework("ApplicationServices"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("AppKit"),
                .linkedFramework("Security"),
                .linkedFramework("Speech"),
                .linkedFramework("Vision"),
                .linkedFramework("Network"),
                .linkedFramework("SpriteKit"),
                .linkedFramework("AVKit"),
                .linkedFramework("AuthenticationServices"),
            ]
        ),
        .executableTarget(
            name: "vellum-assistant",
            dependencies: ["VellumAssistantLib"],
            path: "macos/vellum-assistant-app"
        ),
        .testTarget(
            name: "vellum-assistantTests",
            dependencies: ["VellumAssistantLib"],
            path: "macos/vellum-assistantTests"
        ),
        // iOS app and tests are built via ios/vellum-assistant-ios.xcodeproj (not SPM).
        // See ios/project.yml for the XcodeGen spec.
        .testTarget(
            name: "VellumAssistantSharedTests",
            dependencies: ["VellumAssistantShared"],
            path: "shared/Tests"
        )
    ]
)
