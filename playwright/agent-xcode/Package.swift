// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "agent-xcode",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "agent-xcode",
            path: "Sources",
            linkerSettings: [
                .linkedFramework("ApplicationServices"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("AppKit"),
            ]
        ),
    ]
)
