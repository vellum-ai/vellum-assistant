// swift-tools-version: 6.2
import PackageDescription

let appVersion = "0.6.2"

let package = Package(
    name: "vellum-assistant",
    platforms: [
        .macOS("15.0"),
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
        .library(
            name: "ObjCExceptionCatcher",
            targets: ["ObjCExceptionCatcher"]
        ),
        .executable(
            name: "vellum-assistant",
            targets: ["vellum-assistant"]
        )
        // iOS executable product removed — use ios/vellum-assistant-ios.xcodeproj instead.
    ],
    dependencies: [
        .package(url: "https://github.com/getsentry/sentry-cocoa.git", from: "8.0.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.0.0"),
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", from: "1.0.0"),
    ],
    targets: [
        .target(
            name: "ObjCExceptionCatcher",
            dependencies: [],
            path: "shared/ObjCExceptionCatcher",
            publicHeadersPath: "include"
        ),
        .target(
            name: "VellumAssistantShared",
            dependencies: ["ObjCExceptionCatcher"],
            path: "shared",
            exclude: ["Tests", "ObjCExceptionCatcher"],
            resources: [
                .copy("Resources/LucideIcons"),
                .copy("Resources/LUCIDE-LICENSE"),
                .copy("Resources/lucide-icon-manifest.json"),
                .copy("Resources/lucide-version.txt"),
            ],
            swiftSettings: [
                .define("DEBUG", .when(configuration: .debug)),
                .enableUpcomingFeature("BareSlashRegexLiterals")
            ],
            linkerSettings: [
                .linkedFramework("Network"),  // Required for NWError (ChatErrorManager, ChatViewModel)
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
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ],
            path: "macos/vellum-assistant",
            exclude: ["Resources/Info.plist", "Resources/VellumDocument.icns"],
            resources: [
                .process("Resources/Assets.xcassets"),
                .process("Resources/Fonts"),
                .copy("Resources/Recipes"),
                .process("Resources/Onboarding"),
                .process("Resources/vellum-design-system.css"),
                .process("Resources/vellum-widgets.js"),
                .process("Resources/vellum-edit-animator.js"),
                .copy("Resources/editor"),
                .process("Resources/initial-avatar.png"),
                .process("Resources/vellum-app-icon.png"),
                .process("Resources/welcome-characters.png")
            ],
            swiftSettings: [
                .define("DEBUG", .when(configuration: .debug)),
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
    ],
    // swift-tools-version 6.2 is required by the `containerization` dependency,
    // but the codebase isn't yet migrated to Swift 6 strict concurrency.
    swiftLanguageModes: [.v5]
)
