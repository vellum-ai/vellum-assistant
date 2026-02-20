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
        ),
        .executable(
            name: "vellum-assistant-ios",
            targets: ["vellum-assistant-ios"]
        )
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
        .executableTarget(
            name: "vellum-assistant-ios",
            dependencies: ["VellumAssistantShared"],
            path: "ios",
            exclude: ["Resources/Info.plist", "Resources/vellum-assistant-ios.entitlements", "README.md", "Tests", "build.sh", "dist"],
            resources: [
                .process("Resources/Assets.xcassets"),
                .process("Resources/background.png"),
            ],
            linkerSettings: [
                .linkedFramework("UIKit", .when(platforms: [.iOS])),
                .linkedFramework("SwiftUI", .when(platforms: [.iOS])),
                .linkedFramework("AppIntents", .when(platforms: [.iOS]))
            ]
        ),
        .testTarget(
            name: "vellum-assistant-iosTests",
            dependencies: ["VellumAssistantShared"],
            path: "ios/Tests"
        ),
        .testTarget(
            name: "VellumAssistantSharedTests",
            dependencies: ["VellumAssistantShared"],
            path: "shared/Tests"
        )
    ]
)
