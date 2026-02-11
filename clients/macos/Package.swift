// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "vellum-assistant",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(
            name: "vellum-assistant",
            targets: ["vellum-assistant"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/soffes/HotKey", from: "0.2.1"),
    ],
    targets: [
        .executableTarget(
            name: "vellum-assistant",
            dependencies: ["HotKey"],
            path: "vellum-assistant",
            exclude: ["Resources/Info.plist"],
            resources: [
                .process("Resources/Assets.xcassets"),
                .process("Resources/dino.webp"),
                .process("Resources/Fonts"),
                .copy("Resources/Recipes")
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
            ]
        ),
        .testTarget(
            name: "vellum-assistantTests",
            dependencies: ["vellum-assistant"],
            path: "vellum-assistantTests"
        )
    ]
)
