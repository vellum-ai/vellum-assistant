// swift-tools-version: 5.9
import PackageDescription

let appVersion = "0.4.45"

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
        .package(url: "https://github.com/getsentry/sentry-cocoa.git", from: "8.0.0"),
    ],
    targets: [
        .target(
            name: "VellumAssistantShared",
            dependencies: [],
            path: "shared",
            exclude: ["Tests"],
            resources: [
                .copy("Resources/LucideIcons"),
                .copy("Resources/LUCIDE-LICENSE"),
                .copy("Resources/lucide-icon-manifest.json"),
                .copy("Resources/lucide-version.txt"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("BareSlashRegexLiterals")
            ],
            linkerSettings: [
                .linkedFramework("Network"),  // Required for KeychainBrokerServer (NWListener/NWConnection)
                .linkedFramework("AuthenticationServices"),  // Required for shared AuthManager (ASWebAuthenticationSession)
            ]
        ),
        // VellumAssistantLib: macOS-only target (links AppKit, ScreenCaptureKit, etc.)
        // iOS apps should depend only on VellumAssistantShared, not this target.
        .target(
            name: "VellumAssistantLib",
            dependencies: [
                "VellumAssistantShared",
                "Sparkle",
                .product(name: "Sentry", package: "sentry-cocoa"),
            ],
            path: "macos/vellum-assistant",
            exclude: ["Resources/Info.plist", "Resources/bg.png", "Resources/VellumDocument.icns"],
            resources: [
                .process("Resources/Assets.xcassets"),
                .process("Resources/meadow.svg"),
                .process("Resources/background.png"),
                .process("Resources/Fonts"),
                .copy("Resources/Recipes"),
                .process("Resources/Onboarding"),
                .process("Resources/vellum-design-system.css"),
                .process("Resources/vellum-widgets.js"),
                .process("Resources/vellum-edit-animator.js"),
                .copy("Resources/editor"),
                .process("Resources/initial-avatar.png"),
                .process("Resources/vellum-app-icon.png")
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
        ),
        .testTarget(
            name: "VellumAssistantIOSTests",
            dependencies: ["VellumAssistantShared"],
            path: "ios/Tests"
        )
    ]
)
