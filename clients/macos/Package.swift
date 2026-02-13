// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "vellum-assistant",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "VellumAssistantLib",
            targets: ["VellumAssistantLib"]
        ),
        .executable(
            name: "vellum-assistant",
            targets: ["vellum-assistant"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/soffes/HotKey", from: "0.2.1"),
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.0.0"),
    ],
    targets: [
        .target(
            name: "VellumAssistantLib",
            dependencies: ["HotKey", "Sparkle"],
            path: "vellum-assistant",
            exclude: ["Resources/Info.plist"],
            resources: [
                .process("Resources/Assets.xcassets"),
                .process("Resources/meadow.svg"),
                .process("Resources/bg.png"),
                .process("Resources/Fonts"),
                .copy("Resources/Recipes"),
                .process("Resources/Onboarding")
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
                .linkedFramework("AuthenticationServices"),
            ]
        ),
        .executableTarget(
            name: "vellum-assistant",
            dependencies: ["VellumAssistantLib"],
            path: "vellum-assistant-app"
        ),
        .testTarget(
            name: "vellum-assistantTests",
            dependencies: ["VellumAssistantLib"],
            path: "vellum-assistantTests"
        )
    ]
)
